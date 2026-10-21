
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const app = express();

app.use(cors({ origin: '*' })); // Restrict origins before public deployment.
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));

const PORT = Number(process.env.PORT || 3000);

// SQLite database locations.
const DATA_DIR = path.join(__dirname, 'data');
const STUDENT_DB_DIR = path.join(DATA_DIR, 'student_dbs');

fs.mkdirSync(STUDENT_DB_DIR, { recursive: true });

const mainDb = new DatabaseSync(path.join(DATA_DIR, 'sql-mentor.db'));
mainDb.exec('PRAGMA foreign_keys = ON;');

const id = () => crypto.randomUUID();

const cleanName = value =>
  String(value || '').trim().replace(/\s+/g, ' ').slice(0, 50);

// Initialize OpenAI only when an API key is configured.
const OpenAI = require('openai');
const ai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'SQL_Mentor_newest.html'));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'SQL Mentor API', database: 'SQLite' });
});

// Main application tables.
mainDb.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    student_db TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT 'General',
    question_text TEXT NOT NULL DEFAULT '',
    sql_text TEXT NOT NULL,
    succeeded INTEGER NOT NULL DEFAULT 0,
    rows_affected INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_attempts_student_date
  ON attempts(student_id, created_at);
`);

const LIBRARY_SCHEMA = `
Authors(author_id INTEGER PRIMARY KEY, author_name TEXT NOT NULL)
Books(book_id INTEGER PRIMARY KEY, title TEXT NOT NULL, price REAL, year INTEGER, category TEXT, author_id INTEGER)
Students(student_id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)
Borrow(borrow_id INTEGER PRIMARY KEY, student_id INTEGER, book_id INTEGER, borrow_date TEXT, return_date TEXT)
StudentProgress(progress_id INTEGER PRIMARY KEY, topic TEXT, attempts INTEGER, correct INTEGER)
`;

function getStudentDb(dbName) {
  if (!/^sqlm_[a-f0-9]{32}$/.test(dbName)) {
    throw new Error('Invalid student database identifier.');
  }

  const dbPath = path.join(STUDENT_DB_DIR, `${dbName}.db`);
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function seedStudentDatabase(dbName) {
  const db = getStudentDb(dbName);

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS Authors (
        author_id INTEGER PRIMARY KEY,
        author_name TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS Books (
        book_id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        price REAL,
        year INTEGER,
        category TEXT,
        author_id INTEGER,
        FOREIGN KEY (author_id) REFERENCES Authors(author_id)
      );

      CREATE TABLE IF NOT EXISTS Students (
        student_id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      );

      CREATE TABLE IF NOT EXISTS Borrow (
        borrow_id INTEGER PRIMARY KEY,
        student_id INTEGER NOT NULL,
        book_id INTEGER NOT NULL,
        borrow_date TEXT,
        return_date TEXT
      );

      CREATE TABLE IF NOT EXISTS StudentProgress (
        progress_id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL DEFAULT 'General',
        attempts INTEGER NOT NULL DEFAULT 0,
        correct INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed only when the sample table is empty.
    const count = db.prepare(
      'SELECT COUNT(*) AS total FROM Authors'
    ).get().total;

    if (count === 0) {
      db.exec(`
        INSERT INTO Authors VALUES
          (1, 'Meera Nair'),
          (2, 'Arun Das'),
          (3, 'Kavya Menon');

        INSERT INTO Books VALUES
          (1, 'The Silent Shore', 350.00, 2022, 'Fiction', 1),
          (2, 'Code & Chai', 499.00, 2024, 'Technology', 2),
          (3, 'River of Stars', 275.00, 2021, 'Fiction', 1),
          (4, 'SQL Made Simple', 420.00, 2023, 'Technology', 3);

        INSERT INTO Students VALUES
          (101, 'Anu', 'anu@example.com'),
          (102, 'Ravi', 'ravi@example.com'),
          (103, 'Maya', 'maya@example.com');

        INSERT INTO Borrow VALUES
          (1, 101, 1, '2026-01-10', NULL),
          (2, 102, 2, '2026-02-12', '2026-02-20');
      `);
    }
  } finally {
    db.close();
  }
}

// AI: generate SQL and explain it to the student.
function stripCodeFence(value) {
  return String(value || '')
    .replace(/^```(?:sql)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
    .replace(/;\s*$/, '');
}

app.post('/api/chat', async (req, res) => {
  if (!ai) {
    return res.status(503).json({
      error: 'AI is not configured. Set OPENAI_API_KEY in your .env file.'
    });
  }

  try {
    const question = String(req.body?.question || '')
      .trim()
      .slice(0, 500);

    if (question.length < 3) {
      return res.status(400).json({
        error: 'Please ask a question with at least 3 characters.'
      });
    }

    const sqlResponse = await ai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Convert the student question into ONE SQLite SQL statement. ' +
            'Return only SQL, without markdown or explanation. ' +
            'Use SQLite syntax. Do not generate multiple statements. ' +
            'If the question cannot be answered using the schema, return UNSUPPORTED.\n' +
            'Schema:\n' + LIBRARY_SCHEMA
        },
        { role: 'user', content: question }
      ]
    });

    let sql = stripCodeFence(
      sqlResponse.choices[0]?.message?.content || ''
    );

    if (!sql || /^UNSUPPORTED$/i.test(sql)) {
      return res.json({
        sql: '',
        explanation:
          'Try asking about Authors, Books, Students, Borrow, or StudentProgress.'
      });
    }

    // Reject multiple statements rather than silently executing a partial query.
    if (sql.includes(';')) {
      return res.status(400).json({
        error: 'The AI returned multiple SQL statements. Please try again.'
      });
    }

    const explanationResponse = await ai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content:
            'Explain this SQLite query to a beginner in 3-5 short sentences. ' +
            'Do not use a code block.'
        },
        {
          role: 'user',
          content: `Question: ${question}\nSQL: ${sql}\nExplain the query.`
        }
      ]
    });

    res.json({
      sql,
      explanation:
        explanationResponse.choices[0]?.message?.content?.trim() || ''
    });
  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({
      error: 'AI request failed. Check your API key and connection.'
    });
  }
});

// Classroom demo only: using a name is NOT secure authentication.
app.post('/api/session', (req, res) => {
  let studentDb;

  try {
    const displayName = cleanName(req.body?.name);

    if (displayName.length < 2) {
      return res.status(400).json({
        error: 'Enter a name with at least 2 characters.'
      });
    }

    const nameKey = displayName.toLocaleLowerCase('en-US');

    let student = mainDb.prepare(
      'SELECT id, display_name, student_db FROM students WHERE name_key = ?'
    ).get(nameKey);

    if (!student) {
      const studentId = id();
      const dbName = 'sqlm_' + crypto.randomBytes(16).toString('hex');

      mainDb.prepare(`
        INSERT INTO students (id, display_name, name_key, student_db)
        VALUES (?, ?, ?, ?)
      `).run(studentId, displayName, nameKey, dbName);

      student = {
        id: studentId,
        display_name: displayName,
        student_db: dbName
      };
    }

    mainDb.prepare(
      "UPDATE students SET last_seen = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(student.id);

    seedStudentDatabase(student.student_db);

    res.json({
      studentId: student.id,
      name: student.display_name,
      progress: getProgress(student.id)
    });
  } catch (error) {
    console.error('Session error:', error.message);
    res.status(500).json({ error: 'Could not load the student profile.' });
  }
});

function getProgress(studentId) {
  const totals = mainDb.prepare(`
    SELECT COUNT(*) AS attempts,
           COALESCE(SUM(succeeded), 0) AS correct
    FROM attempts WHERE student_id = ?
  `).get(studentId);

  const topics = mainDb.prepare(`
    SELECT topic,
           COUNT(*) AS attempts,
           COALESCE(SUM(succeeded), 0) AS correct
    FROM attempts
    WHERE student_id = ?
    GROUP BY topic
    ORDER BY topic
  `).all(studentId);

  const recent = mainDb.prepare(`
    SELECT topic, question_text, sql_text, succeeded,
           error_message, created_at
    FROM attempts
    WHERE student_id = ?
    ORDER BY id DESC LIMIT 10
  `).all(studentId);

  return {
    attempts: Number(totals.attempts),
    correct: Number(totals.correct),
    topics,
    recent
  };
}

app.get('/api/progress/:studentId', (req, res) => {
  const student = mainDb.prepare(
    'SELECT id FROM students WHERE id = ?'
  ).get(req.params.studentId);

  if (!student) {
    return res.status(404).json({ error: 'Student profile not found.' });
  }

  res.json(getProgress(student.id));
});

app.get('/api/tables/:studentId', (req, res) => {
  let db;

  try {
    const student = mainDb.prepare(
      'SELECT student_db FROM students WHERE id = ?'
    ).get(req.params.studentId);

    if (!student) {
      return res.status(404).json({ error: 'Student profile not found.' });
    }

    db = getStudentDb(student.student_db);

    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all();

    const result = tables.map(table => {
      const columns = db.prepare(
        `PRAGMA table_info("${table.name.replace(/"/g, '""')}")`
      ).all();

      return {
        name: table.name,
        columns: columns.map(column => ({
          name: column.name,
          type: column.type,
          key: column.pk ? 'PRI' : ''
        }))
      };
    });

    res.json({ tables: result });
  } catch (error) {
    console.error('Tables API error:', error.message);
    res.status(500).json({ error: 'Could not load table definitions.' });
  } finally {
    if (db) db.close();
  }
});

// Restrict the learning SQL to one statement and supported operations.
// This is a classroom safeguard, not a complete SQL security sandbox.
function validateStudentSql(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 10000) {
    throw new Error('Enter a SQL statement (maximum 10,000 characters).');
  }

  const text = sql.trim();
  const query = text.replace(/;\s*$/, '');

  if (query.includes(';')) {
    throw new Error('Run one SQL statement at a time.');
  }

  const allowed =
    /^(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE\s+TABLE|SHOW\s+TABLES|DESCRIBE|DESC)\b/i;

  if (!allowed.test(query)) {
    throw new Error(
      'Allowed commands: SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, ' +
      'ALTER TABLE, DROP TABLE, SHOW TABLES, DESCRIBE and TRUNCATE TABLE.'
    );
  }

  if (/\/\*[\s\S]*?\*\//.test(query) ||
      /--/.test(query) ||
      /\b(ATTACH|DETACH|PRAGMA|VACUUM|LOAD_EXTENSION|READFILE|WRITEFILE)\b/i.test(query)) {
    throw new Error('That SQL feature is disabled in the learning sandbox.');
  }

  return query;
}

// Translate a few common MySQL classroom commands to SQLite equivalents.
function translateSql(sql) {
  if (/^SHOW\s+TABLES$/i.test(sql.trim())) {
    return {
      sql: `SELECT name AS "Tables_in_database"
            FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name`,
      command: 'SELECT'
    };
  }

  const describe = sql.match(/^(?:DESCRIBE|DESC)\s+([a-zA-Z_][a-zA-Z0-9_]*)$/i);

  if (describe) {
    return {
      sql: `PRAGMA table_info("${describe[1]}")`,
      command: 'PRAGMA'
    };
  }

  const truncate = sql.match(/^TRUNCATE\s+TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)$/i);

  if (truncate) {
    return {
      sql: `DELETE FROM "${truncate[1]}"`,
      command: 'DELETE'
    };
  }

  return {
    sql,
    command: sql.match(/^([a-z]+)/i)?.[1].toUpperCase() || 'SQL'
  };
}

app.post('/api/query', (req, res) => {
  const studentId = String(req.body?.studentId || '');
  const topic = String(req.body?.topic || 'General').slice(0, 80);
  const question = String(req.body?.question || '').slice(0, 500);

  let sql;

  try {
    sql = validateStudentSql(req.body?.sql);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const student = mainDb.prepare(
    'SELECT id, student_db FROM students WHERE id = ?'
  ).get(studentId);

  if (!student) {
    return res.status(404).json({
      error: 'Student profile not found. Enter your name again.'
    });
  }

  let db;

  try {
    db = getStudentDb(student.student_db);

    const translated = translateSql(sql);
    const command = translated.command;
    let result;

    if (command === 'SELECT' || command === 'PRAGMA') {
      const rows = db.prepare(translated.sql).all();

      result = {
        columns: rows.length ? Object.keys(rows[0]) : [],
        rows: rows.slice(0, 100),
        rowsAffected: rows.length,
        command
      };
    } else {
      const statement = db.prepare(translated.sql);
      const info = statement.run();

      result = {
        columns: [],
        rows: [],
        rowsAffected: Number(info.changes || 0),
        command
      };
    }

    mainDb.prepare(`
      INSERT INTO attempts
        (student_id, topic, question_text, sql_text, succeeded, rows_affected)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(student.id, topic, question, sql, result.rowsAffected);

    res.json({ ...result, progress: getProgress(student.id) });
  } catch (error) {
    try {
      mainDb.prepare(`
        INSERT INTO attempts
          (student_id, topic, question_text, sql_text, succeeded, rows_affected, error_message)
        VALUES (?, ?, ?, ?, 0, 0, ?)
      `).run(
        student.id,
        topic,
        question,
        sql,
        String(error.message || 'SQL error').slice(0, 500)
      );
    } catch (historyError) {
      console.error('Could not save attempt:', historyError.message);
    }

    res.status(400).json({
      error: String(error.message || 'SQL execution failed').slice(0, 500)
    });
  } finally {
    if (db) db.close();
  }
});

function start() {
  mainDb.prepare('SELECT 1').get();

  app.listen(PORT, () => {
    console.log(`SQL Mentor running on http://localhost:${PORT}`);
    console.log('Database: SQLite (node:sqlite)');
  });
}

start();
