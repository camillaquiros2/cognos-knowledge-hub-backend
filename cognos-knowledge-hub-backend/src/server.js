import express from "express";
import cors from "cors";
import morgan from "morgan";
import { pool } from "./db.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// ---------- Health ----------
app.get("/health", async (_req, res) => {
    try {
        const [r] = await pool.query("SELECT 1 AS ok");
        res.json({ status: "ok", db: r[0].ok === 1, time: new Date().toISOString() });
    } catch (e) {
        res.status(500).json({ status: "error", error: String(e) });
    }
});

// ---------- Articles: list with metadata ----------
app.get("/api/articles", async (_req, res) => {
    const [rows] = await pool.query(`
    SELECT a.id, a.title, a.summary, a.source_url, a.updated_at,
           v.label AS version,
           c.name  AS category,
           m.name  AS module
    FROM articles a
    LEFT JOIN versions   v ON a.version_id  = v.id
    LEFT JOIN categories c ON a.category_id = c.id
    LEFT JOIN modules    m ON a.module_id   = m.id
    WHERE a.status = 'published'
    ORDER BY a.updated_at DESC
    LIMIT 100
  `);
    res.json(rows);
});

// ---------- Article detail ----------
app.get("/api/articles/:id", async (req, res) => {
    const [rows] = await pool.query(
        `SELECT a.id, a.title, a.summary, a.source_url, a.updated_at,
            v.label AS version,
            a.category_id, c.name AS category,
            a.module_id,   m.name AS module
     FROM articles a
     LEFT JOIN versions   v ON a.version_id = v.id
     LEFT JOIN categories c ON a.category_id = c.id
     LEFT JOIN modules    m ON a.module_id   = m.id
     WHERE a.id = ?`,
        [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
});

// ---------- Create article ----------
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
              a.category_id, c.name AS category,
              a.module_id,   m.name AS module
       FROM articles a
       LEFT JOIN versions   v ON a.version_id = v.id
       LEFT JOIN categories c ON a.category_id = c.id
       LEFT JOIN modules    m ON a.module_id   = m.id
       WHERE a.id = ?`,
            [newId]
        );

        res.status(201).location(`/api/articles/${newId}`).json(rows[0]);
    } catch (err) {
        // Mapea error de FK a 400
        if (err?.code === 'ER_NO_REFERENCED_ROW_2' || err?.errno === 1452) {
            return res.status(400).json({ error: "FK inválida en version_id/category_id/module_id" });
        }
        res.status(500).json({ error: "Error al crear", detail: String(err) });
    }
});

// ---------- Update (partial) ----------
app.put("/api/articles/:id", async (req, res) => {
    const allowed = ["title", "summary", "source_url", "version_id", "status", "category_id", "module_id"];
    const fields = Object.keys(req.body || {}).filter((k) => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: "Nada que actualizar" });

    const setClause = fields.map((f) => `${f} = :${f}`).join(", ");
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
              a.category_id, c.name AS category,
              a.module_id,   m.name AS module
       FROM articles a
       LEFT JOIN versions   v ON a.version_id = v.id
       LEFT JOIN categories c ON a.category_id = c.id
       LEFT JOIN modules    m ON a.module_id   = m.id
       WHERE a.id = ?`,
            [req.params.id]
        );
        res.json(rows[0]);
    } catch (err) {
        if (err?.code === 'ER_NO_REFERENCED_ROW_2' || err?.errno === 1452) {
            return res.status(400).json({ error: "FK inválida en version_id/category_id/module_id" });
        }
        res.status(500).json({ error: "Error al actualizar", detail: String(err) });
    }
});

// ---------- Delete ----------
app.delete("/api/articles/:id", async (req, res) => {
    const [r] = await pool.execute(`DELETE FROM articles WHERE id = :id`, { id: req.params.id });
    if (r.affectedRows === 0) return res.status(404).json({ error: "Not found" });
    res.status(204).send();
});

// ---------- Categories ----------
app.get("/api/categories", async (_req, res) => {
    const [rows] = await pool.query("SELECT id, name, description FROM categories ORDER BY name");
    res.json(rows);
});

// ---------- Tags ----------
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

// ---------- FAQs ----------
app.get("/api/faqs", async (req, res) => {
    const { article_id } = req.query;
    let sql = `SELECT id, question, answer, article_id, created_at FROM faqs`;
    const params = [];
    if (article_id) { sql += " WHERE article_id = ?"; params.push(article_id); }
    sql += " ORDER BY created_at DESC";
    const [rows] = await pool.query(sql, params);
    res.json(rows);
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API listening on http://localhost:" + PORT));
