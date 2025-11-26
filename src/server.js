import express from "express";
import cors from "cors";
import morgan from "morgan";
import { pool } from "./db.js";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

/* ============================================================
   HEALTH CHECK
   ============================================================ */
app.get("/health", async (_req, res) => {
    try {
        const [r] = await pool.query("SELECT 1 AS ok");
        res.json({ status: "ok", db: r[0].ok === 1, time: new Date().toISOString() });
    } catch (e) {
        res.status(500).json({ status: "error", error: String(e) });
    }
});

/* ============================================================
   ARTICLES — LIST, SEARCH, GET, CREATE, UPDATE, DELETE
   ============================================================ */

// 🔍 List articles (NO TOCADO)
app.get("/api/articles", async (_req, res) => {
    const [rows] = await pool.query(`
        SELECT a.id, a.title, a.summary, a.source_url, a.updated_at,
               v.label AS version,
               c.name AS category,
               m.name AS module
        FROM articles a
            LEFT JOIN versions v ON a.version_id = v.id
            LEFT JOIN categories c ON a.category_id = c.id
            LEFT JOIN modules m ON a.module_id = m.id
        WHERE a.status = 'published'
        ORDER BY a.updated_at DESC
            LIMIT 100
    `);
    res.json(rows);
});

/* ============================================================
   🔥 SEARCH — SE MUEVE ARRIBA DEL :id
   ============================================================ */
app.get("/api/articles/search", async (req, res) => {
    const keyword  = (req.query.keyword  || "").trim().toLowerCase();
    const version  = (req.query.version  || "").trim();
    const category = (req.query.category || "").trim();
    const module   = (req.query.module   || "").trim();

    let sql = `
        SELECT 
            a.id, a.title, a.summary, a.source_url, a.updated_at,
            v.label AS version,
            c.name AS category,
            m.name AS module
        FROM articles a
        LEFT JOIN versions v ON a.version_id = v.id
        LEFT JOIN categories c ON a.category_id = c.id
        LEFT JOIN modules m ON a.module_id = m.id
        WHERE a.status = 'published'
    `;

    const params = [];

    if (keyword) {
        sql += ` AND (
            LOWER(a.title) LIKE ?
            OR LOWER(a.summary) LIKE ?
        )`;
        params.push(`%${keyword}%`, `%${keyword}%`);
    }

    if (version && version !== "All") {
        sql += ` AND v.label = ?`;
        params.push(version);
    }

    if (category && category !== "All") {
        sql += ` AND c.name = ?`;
        params.push(category);
    }

    if (module && module !== "All") {
        sql += ` AND m.name = ?`;
        params.push(module);
    }

    sql += " ORDER BY a.updated_at DESC LIMIT 100";

    try {
        const [rows] = await pool.query(sql, params);
        res.json(rows);
    } catch (err) {
        console.error("Search error:", err);
        res.status(500).json({ error: "Search failed", detail: String(err) });
    }
});

/* ============================================================
   🔍 Article detail — AHORA VIENE DESPUÉS DEL SEARCH
   ============================================================ */
app.get("/api/articles/:id", async (req, res) => {
    const [rows] = await pool.query(
        `SELECT a.id, a.title, a.summary, a.source_url, a.updated_at,
                v.label AS version,
                c.name AS category,
                m.name AS module
         FROM articles a
             LEFT JOIN versions v ON a.version_id = v.id
             LEFT JOIN categories c ON a.category_id = c.id
             LEFT JOIN modules m ON a.module_id = m.id
         WHERE a.id = ?`,
        [req.params.id]
    );

    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
});

// 📝 CREATE (NO TOCADO)
app.post("/api/articles", async (req, res) => {
    const {
        title,
        summary,
        source_url,
        version_id = null,
        status = "published",
        category_id = null,
        module_id = null
    } = req.body || {};

    if (!title || !summary || !source_url) {
        return res.status(400).json({ error: "title, summary y source_url son requeridos" });
    }

    try {
        const [r] = await pool.execute(
            `INSERT INTO articles (title, summary, source_url, version_id, status, category_id, module_id)
             VALUES (:title, :summary, :source_url, :version_id, :status, :category_id, :module_id)`,
            { title, summary, source_url, version_id, status, category_id, module_id }
        );

        const newId = r.insertId;
        const [rows] = await pool.query(
            `SELECT a.id, a.title, a.summary, a.source_url, a.updated_at,
                    v.label AS version,
                    c.name AS category,
                    m.name AS module
             FROM articles a
                 LEFT JOIN versions v ON a.version_id = v.id
                 LEFT JOIN categories c ON a.category_id = c.id
                 LEFT JOIN modules m ON a.module_id = m.id
             WHERE a.id = ?`,
            [newId]
        );

        res.status(201).json(rows[0]);
    } catch (err) {
        if (err?.errno === 1452)
            return res.status(400).json({ error: "FK inválida en version_id/category_id/module_id" });

        res.status(500).json({ error: "Error al crear", detail: String(err) });
    }
});

// 🛠 UPDATE (NO TOCADO)
app.put("/api/articles/:id", async (req, res) => {
    const allowed = [
        "title", "summary", "source_url",
        "version_id", "status", "category_id", "module_id"
    ];

    const fields = Object.keys(req.body || {}).filter(k => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: "Nada que actualizar" });

    const setClause = fields.map(f => `${f} = :${f}`).join(", ");
    const params = { ...req.body, id: req.params.id };

    try {
        const [r] = await pool.execute(
            `UPDATE articles SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = :id`,
            params
        );

        if (r.affectedRows === 0) return res.status(404).json({ error: "Not found" });

        const [rows] = await pool.query(
            `SELECT a.id, a.title, a.summary, a.source_url, a.updated_at,
                    v.label AS version,
                    c.name AS category,
                    m.name AS module
             FROM articles a
                 LEFT JOIN versions v ON a.version_id = v.id
                 LEFT JOIN categories c ON a.category_id = c.id
                 LEFT JOIN modules m ON a.module_id = m.id
             WHERE a.id = ?`,
            [req.params.id]
        );

        res.json(rows[0]);
    } catch (err) {
        if (err?.errno === 1452)
            return res.status(400).json({ error: "FK inválida en version_id/category_id/module_id" });

        res.status(500).json({ error: "Error al actualizar", detail: String(err) });
    }
});

// 🗑 DELETE (NO TOCADO)
app.delete("/api/articles/:id", async (req, res) => {
    const [r] = await pool.execute(
        `DELETE FROM articles WHERE id = :id`,
        { id: req.params.id }
    );
    if (r.affectedRows === 0) return res.status(404).json({ error: "Not found" });
    res.status(204).send();
});

/* ============================================================
   CATEGORIES, TAGS, FAQS (NO TOCADO)
   ============================================================ */

app.get("/api/categories", async (_req, res) => {
    const [rows] = await pool.query("SELECT id, name, description FROM categories ORDER BY name");
    res.json(rows);
});

app.get("/api/tags", async (_req, res) => {
    const [rows] = await pool.query("SELECT id, name FROM tags ORDER BY name");
    res.json(rows);
});

app.get("/api/articles/:id/tags", async (req, res) => {
    const [rows] = await pool.query(
        `SELECT t.id, t.name
         FROM article_tags at
         JOIN tags t ON t.id = at.tag_id
         WHERE at.article_id = ?
         ORDER BY t.name`,
        [req.params.id]
    );
    res.json(rows);
});

app.get("/api/faqs", async (req, res) => {
    const { article_id } = req.query;
    let sql = `SELECT id, question, answer, article_id, created_at FROM faqs`;
    const params = [];

    if (article_id) {
        sql += " WHERE article_id = ?";
        params.push(article_id);
    }

    sql += " ORDER BY created_at DESC";

    const [rows] = await pool.query(sql, params);
    res.json(rows);
});

/* ============================================================
   VERSIONS & MODULES (NO TOCADO)
   ============================================================ */

app.get("/api/versions", async (_req, res) => {
    const [rows] = await pool.query(
        "SELECT id, label FROM versions ORDER BY id"
    );
    res.json(rows);
});

app.get("/api/modules", async (_req, res) => {
    const [rows] = await pool.query(
        "SELECT id, name FROM modules ORDER BY name"
    );
    res.json(rows);
});

/* ============================================================
   AUTOCOMPLETE (NO TOCADO)
   ============================================================ */

app.get("/api/suggestions", async (req, res) => {
    const q = (req.query.q || "").trim().toLowerCase();

    if (q.length === 0) return res.json([]);

    const [rows] = await pool.query(`
        SELECT DISTINCT title
        FROM articles
        WHERE status = 'published'
          AND (LOWER(title) LIKE ? OR LOWER(summary) LIKE ?)
            LIMIT 8
    `, [`%${q}%`, `%${q}%`]);

    res.json(rows.map(r => r.title));
});

/* ============================================================
   AI — HUGO (NO TOCADO)
   ============================================================ */

const client = new OpenAI({ apiKey: process.env.OPENAI_KEY });

app.post("/ai/query", async (req, res) => {
    try {
        const { message } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ error: "Message is required" });
        }

        const completion = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `
You are **Hugo**, a friendly and professional assistant specialized ONLY in Cognos Analytics.

LANGUAGE RULES
- Always answer in the SAME language the user used in their LAST message.
- If the user explicitly asks to switch languages (e.g. "speak English", "habla español"), then switch and continue in that language.
- Do NOT mix languages in the same answer unless the user clearly asks you to.

SCOPE RULES
- You ONLY help with Cognos Analytics topics: XQE, dispatcher, gateway, content manager, CAF, JDBC/ODBC, namespaces, security, logging, reports, dashboards, data sources, configuration, installation, upgrades, performance, troubleshooting, architecture, etc.
- If the question is clearly about something NOT related to Cognos (for example: viajes, comida, películas, clima, vida personal, etc.), answer:
  "Lo siento, solo puedo ayudarte con temas relacionados a Cognos Analytics."
- BUT if the user says something general like "I need help", "necesito ayuda", "I have a question", etc., assume they want help with Cognos and reply asking what issue they have with Cognos Analytics.

IDENTITY
- When the user asks who you are, briefly introduce yourself as Hugo, an assistant specialized in Cognos Analytics, using the same language the user is using.

STYLE
- Be clear, concise, friendly and practical.
- When useful, provide step-by-step troubleshooting and mention relevant logs/config files or components.
`
                },
                { role: "user", content: message }
            ]
        });

        res.json({ reply: completion.choices[0].message.content });

    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ error: "Error communicating with Hugo" });
    }
});

/* ============================================================
   START SERVER
   ============================================================ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
    console.log(`API listening on http://localhost:${PORT}`)
);
