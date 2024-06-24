/*
* dev: Sazumi Viki
* github: github.com/sazumivicky
* ig: @moe.sazumiviki
* site: www.sazumi.moe
*/

import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { Client } from 'pg';
import dotenv from 'dotenv';
import mime from 'mime-types';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Setup PostgreSQL client
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

client.connect()
  .then(() => console.log('PostgreSQL connected'))
  .catch(err => console.error('PostgreSQL connection error:', err));

// Ensure tables exist
const ensureTablesExist = async () => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS shares (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255),
      khodam VARCHAR(255),
      photo_url TEXT,
      share_id VARCHAR(255)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS views (
      id SERIAL PRIMARY KEY,
      total_views INT DEFAULT 0
    )
  `);

  // Ensure there's one row in views table
  const res = await client.query('SELECT * FROM views');
  if (res.rows.length === 0) {
    await client.query('INSERT INTO views (total_views) VALUES (0)');
  }
};

ensureTablesExist();

const tmpDir = './tmp';
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const fileFilter = (req, file, cb) => {
  const mimeType = mime.lookup(file.originalname);
  if (mimeType && mimeType.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only image files are allowed.'));
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(async (req, res, next) => {
  const result = await client.query('SELECT * FROM views LIMIT 1');
  let viewData = result.rows[0];

  if (!req.cookies.viewed) {
    await client.query('UPDATE views SET total_views = total_views + 1 WHERE id = $1', [viewData.id]);
    res.cookie('viewed', 'true', { maxAge: 24 * 60 * 60 * 1000 });
    viewData.total_views += 1;
  }

  res.locals.totalViews = viewData.total_views;
  next();
});

async function uploadToCdn(filePath) {
  const formData = new FormData();
  formData.append('fileInput', fs.createReadStream(filePath));

  try {
    const response = await fetch('https://cdn.sazumi.moe/upload', {
      method: 'POST',
      body: formData
    });

    if (response.ok) {
      const fileUrl = await response.json();
      console.log('Successfully:', fileUrl);
      return fileUrl.url_response;
    } else {
      const errorResponse = await response.json();
      console.error('oops something went wrong:', errorResponse);
      throw new Error('Failed to upload to CDN');
    }
  } catch (error) {
    console.error('oops something went wrong:', error.message);
    throw error;
  }
}

app.post('/submit', upload.single('photo'), async (req, res) => {
  const name = req.body.name;
  const localPhotoPath = req.file.path;

  try {
    const photoUrl = await uploadToCdn(localPhotoPath);

    fs.readFile('./khodam/list.txt', 'utf8', async (err, data) => {
      if (err) {
        console.error('Error reading khodam list:', err);
        return res.status(500).send('Internal Server Error');
      }

      const khodams = data.split('\n').filter(k => k.trim().length > 0);
      const randomKhodam = khodams[Math.floor(Math.random() * khodams.length)];

      const shareId = crypto.randomBytes(3).toString('hex');
      const newShare = {
        name,
        khodam: randomKhodam,
        photo_url: photoUrl,
        share_id: shareId
      };

      await client.query(
        'INSERT INTO shares (name, khodam, photo_url, share_id) VALUES ($1, $2, $3, $4)',
        [newShare.name, newShare.khodam, newShare.photo_url, newShare.share_id]
      );

      res.json({ name, khodam: randomKhodam, photoUrl: photoUrl, shareId });
    });
  } catch (error) {
    res.status(500).send('Failed to upload photo');
  }
});

app.get('/share/:id', async (req, res) => {
  const result = await client.query('SELECT * FROM shares WHERE share_id = $1', [req.params.id]);
  const shareData = result.rows[0];

  if (!shareData) {
    return res.status(404).send('Not Found');
  }

  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

app.get('/share-data/:id', async (req, res) => {
  const result = await client.query('SELECT * FROM shares WHERE share_id = $1', [req.params.id]);
  const shareData = result.rows[0];

  if (!shareData) {
    return res.status(404).send('Not Found');
  }

  res.json(shareData);
});

app.get('/total-views', async (req, res) => {
  const result = await client.query('SELECT * FROM views LIMIT 1');
  const viewData = result.rows[0];
  res.json({ totalViews: viewData.total_views });
});

app.use((req, res, next) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
