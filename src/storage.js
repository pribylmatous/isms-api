// Ukládání souborů dokumentů (knihovna dokumentů) na disk.
// Nahraný soubor se drží v paměti (multer memoryStorage), dokud handler
// v routes.js nerozhodne, že jde o skutečnou náhradu — teprve pak se zapíše
// pod náhodným názvem do uploads/. Díky tomu prázdný <input type="file">
// při úpravě metadat bez výměny souboru nezanechává na disku prázdné soubory.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const UPLOAD_DIR = process.env.ISMS_UPLOADS ?? path.join(__dirname, '..', 'uploads');
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.odt'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter(req, file, cb) {
    // Prázdný <input type="file"> (žádný soubor vybrán) se v multipart
    // požadavku pošle jako díl bez jména — necháme ho projít, handler ho
    // pozná podle nulové velikosti a ignoruje.
    if (!file.originalname) return cb(null, true);
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(Object.assign(new Error(`Nepovolený typ souboru: ${ext || '(bez přípony)'}`), { status: 400 }));
    }
    cb(null, true);
  },
});

// Middleware pro upload jednoho souboru v poli 'file'; chyby (nepovolený typ,
// překročený limit) převede na standardní httpError místo multerí výjimky.
export function uploadDocument(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(Object.assign(new Error('Soubor je příliš velký (max 20 MB)'), { status: 400 }));
    }
    next(Object.assign(err, { status: err.status ?? 400 }));
  });
}

// req.file z uploadDocument, pokud byl skutečně vybrán soubor (ne prázdný díl formuláře)
export function pickedFile(req) {
  return req.file && req.file.size > 0 ? req.file : null;
}

export function saveFile(file) {
  const stored = randomUUID() + path.extname(file.originalname).toLowerCase();
  writeFileSync(path.join(UPLOAD_DIR, stored), file.buffer);
  return { stored, name: file.originalname, size: file.size, mime: file.mimetype };
}

export function deleteFile(stored) {
  if (!stored) return;
  try {
    unlinkSync(path.join(UPLOAD_DIR, stored));
  } catch {
    // soubor už neexistuje — nic se neděje
  }
}
