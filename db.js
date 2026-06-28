// crunchy-backend/db.js
const { Pool } = require('pg');
require('dotenv').config();

// Si existe DATABASE_URL (producción), la usa. Si no, usa la configuración local.
const pool = process.env.DATABASE_URL 
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
    });

pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('❌ Error en PostgreSQL:', err.stack);
  else console.log('✅ Conexión exitosa a PostgreSQL');
});

module.exports = pool;