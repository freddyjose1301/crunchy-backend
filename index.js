// index.js
const express = require('express');
const cors = require('cors');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions, 
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

// Configuración básica para WebAuthn
const rpName = 'Crunchy Club ERP';
// El rpID debe ser exactamente tu dominio web sin el https://
const rpID = 'crunchy-club-new.onrender.com'; 
// El origin debe ser la URL completa exacta
const origin = 'https://crunchy-club-new.onrender.com';

// Variable temporal en memoria para guardar el desafío durante el proceso de registro
// (En una app real con múltiples usuarios esto iría en la sesión)
let currentChallenge = '';
const pool = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ==========================================
// MÓDULO BIOMÉTRICO (WEBAUTHN - INICIO DE SESIÓN)
// ==========================================

// 4. Generar el desafío criptográfico para el Login
// Variable temporal en memoria para el desafío de login
let currentLoginChallenge = '';

// ==========================================
// MÓDULO BIOMÉTRICO (WEBAUTHN V10 - LIMPIO)
// ==========================================

app.get('/api/auth/register-options', async (req, res) => {
  try {
    const userOptions = await generateRegistrationOptions({
      rpName, rpID,
      userID: new Uint8Array(Buffer.from('user_crunchy_master')), 
      userName: 'freddyjose13',
      userDisplayName: 'Freddy Villegas',
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred', authenticatorAttachment: 'platform' },
    });
    currentChallenge = userOptions.challenge;
    res.json(userOptions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/register-verify', async (req, res) => {
  try {
    const verification = await verifyRegistrationResponse({
      response: req.body, expectedChallenge: currentChallenge, expectedOrigin: origin, expectedRPID: rpID,
    });
    if (verification.verified && verification.registrationInfo) {
      const credential = verification.registrationInfo.credential || verification.registrationInfo;
      // Guardamos el ID como texto puro y la llave como Base64
      const idString = credential.id; 
      const publicKeyBase64 = Buffer.from(credential.publicKey).toString('base64');
      
      await pool.query(
        'INSERT INTO authenticators (id, user_id, public_key, counter, device_type) VALUES ($1, $2, $3, $4, $5)',
        [idString, 'user_crunchy_master', publicKeyBase64, credential.counter, 'internal_biometric']
      );
      res.json({ verified: true });
    } else {
      res.status(400).json({ verified: false, error: 'Firma rechazada' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/check-biometric', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM authenticators WHERE user_id = $1', ['user_crunchy_master']);
    res.json({ linked: parseInt(result.rows[0].count) > 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/login-options', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM authenticators WHERE user_id = $1', ['user_crunchy_master']);
    if (result.rows.length === 0) return res.status(404).json({ error: 'No hay huellas registradas.' });

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: result.rows.map(row => ({
        id: row.id, // Leemos el texto puro de PostgreSQL
        type: 'public-key',
        transports: ['internal'],
      })),
      userVerification: 'preferred',
    });
    currentLoginChallenge = options.challenge;
    res.json(options);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login-verify', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM authenticators WHERE id = $1', [req.body.id]);
    if (result.rows.length === 0) return res.status(400).json({ verified: false, error: 'Credencial no existe en BD' });
    
    const authenticator = result.rows[0];
    const publicKeyArray = new Uint8Array(Buffer.from(authenticator.public_key, 'base64'));

    const verification = await verifyAuthenticationResponse({
      response: req.body, 
      expectedChallenge: currentLoginChallenge, 
      expectedOrigin: origin, 
      expectedRPID: rpID,
      authenticator: {
        credentialID: authenticator.id,
        credentialPublicKey: publicKeyArray,
        counter: parseInt(authenticator.counter),
      },
    });

    if (verification.verified) {
      await pool.query('UPDATE authenticators SET counter = $1 WHERE id = $2', [verification.authenticationInfo.newCounter, authenticator.id]);
      res.json({ verified: true });
    } else {
      res.status(400).json({ verified: false, error: 'Firma criptográfica inválida' });
    }
  } catch (error) {
    // ENVIAMOS EL ERROR TEXTUAL DIRECTO AL TELÉFONO
    res.status(400).json({ verified: false, error: error.message });
  }
});

app.delete('/api/auth/reset-biometric', async (req, res) => {
  try {
    await pool.query('DELETE FROM authenticators WHERE user_id = $1', ['user_crunchy_master']);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 1. MÓDULO DE INVENTARIO / INSUMOS
// ==========================================

// Obtener todos los insumos (Bolsas y Stickers)
app.get('/api/insumos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM inventory_items ORDER BY category ASC');
    res.json(result.rows);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al obtener insumos' });
  }
});

// Registrar la compra de un insumo (Maneja el promedio ponderado automático)
app.post('/api/insumos', async (req, res) => {
  const { category, name, quantity, total_cost_bs } = req.body;
  try {
    // Forzar nombre único para los stickers del negocio
    const finalName = category === 'stickers' ? 'Sticker Crunchy Club' : name;

    // Verificar si ya existe ese insumo para promediar costo
    const existing = await pool.query(
      'SELECT * FROM inventory_items WHERE LOWER(name) = LOWER($1) AND category = $2',
      [finalName, category]
    );

    if (existing.rows.length > 0) {
      const item = existing.rows[0];
      const newQty = item.quantity + parseInt(quantity);
      const newCost = parseFloat(item.total_cost_bs) + parseFloat(total_cost_bs);

      const updateResult = await pool.query(
        'UPDATE inventory_items SET quantity = $1, total_cost_bs = $2 WHERE id = $3 RETURNING *',
        [newQty, newCost, item.id]
      );
      return res.json({ message: 'Insumo actualizado y promediado', data: updateResult.rows[0] });
    } else {
      // Si es nuevo, lo inserta de cero
      const insertResult = await pool.query(
        'INSERT INTO inventory_items (category, name, quantity, total_cost_bs) VALUES ($1, $2, $3, $4) RETURNING *',
        [category, finalName, quantity, total_cost_bs]
      );
      return res.json({ message: 'Nuevo insumo registrado', data: insertResult.rows[0] });
    }
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al procesar la compra' });
  }
});

// ==========================================
// 2. MÓDULO DE PRODUCCIÓN (JUST-IN-TIME)
// ==========================================

// Registrar producción: Descuenta insumos y suma a productos terminados
app.post('/api/produccion', async (req, res) => {
  const { productName, bagId, stickersQty, bagsAchieved, salePriceEur } = req.body;
  
  const client = await pool.connect(); // Usamos cliente para manejar la transacción de forma segura
  try {
    await client.query('BEGIN');

    // 1. Descontar las bolsas utilizadas
    await client.query(
      'UPDATE inventory_items SET quantity = quantity - $1 WHERE id = $2 AND quantity >= $1',
      [bagsAchieved, bagId]
    );

    // 2. Descontar los stickers (buscando por su categoría)
    await client.query(
      "UPDATE inventory_items SET quantity = quantity - $1 WHERE category = 'stickers' AND quantity >= $1",
      [stickersQty]
    );

    // 3. Insertar o actualizar el producto terminado (SKU)
    const existingProd = await client.query('SELECT * FROM productos_terminados WHERE LOWER(name) = LOWER($1)', [productName]);
    
    if (existingProd.rows.length > 0) {
      await client.query(
        'UPDATE productos_terminados SET quantity = quantity + $1, price_eur = $2 WHERE id = $3',
        [bagsAchieved, salePriceEur, existingProd.rows[0].id]
      );
    } else {
      await client.query(
        'INSERT INTO productos_terminados (name, quantity, price_eur) VALUES ($1, $2, $3)',
        [productName, bagsAchieved, salePriceEur]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Producción procesada exitosamente en bloque' });
  } catch (error) {
    await client.query('ROLLBACK'); // Si algo falla, revierte todo para no corromper datos
    console.error(error.message);
    res.status(500).json({ error: 'Error crítico en producción. Verifique existencias de insumos.' });
  } finally {
    client.release();
  }
});

// ==========================================
// 3. MÓDULO DE VENTAS Y CLIENTES
// ==========================================

// Obtener lista completa de clientes
app.get('/api/clientes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clients ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
});

// Registrar nueva venta entregada (Cuentas por cobrar)
app.post('/api/ventas', async (req, res) => {
  const { clientName, productId, quantity, totalOwedBs } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Descontar stock del producto terminado vendido
    const productCheck = await client.query('SELECT quantity FROM productos_terminados WHERE id = $1', [productId]);
    if (productCheck.rows.length === 0 || productCheck.rows[0].quantity < quantity) {
      throw new Error('No hay suficiente producto terminado en stock');
    }

    await client.query('UPDATE productos_terminados SET quantity = quantity - $1 WHERE id = $2', [quantity, productId]);

    // 2. Crear la cuenta por cobrar en la tabla de clientes
    await client.query(
      "INSERT INTO clients (name, packages, total_owed_bs, status) VALUES ($1, $2, $3, 'Debe')",
      [clientName, quantity, totalOwedBs]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Venta registrada en cuentas por cobrar' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error.message);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Cambiar estatus de una deuda a Pagado
app.put('/api/clientes/:id/pago', async (req, res) => {
  const { id } = req.params;
  const { exactPaidBs } = req.body; // El monto real cobrado
  try {
    // Registramos que ya pagó y guardamos el monto exacto final que entró a caja
    await pool.query(
      "UPDATE clients SET status = 'Pagado', total_owed_bs = $1 WHERE id = $2",
      [exactPaidBs, id]
    );
    res.json({ success: true, message: 'Pago asentado correctamente' });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al asentar el pago' });
  }
});

// Endpoint base de verificación de productos terminados
app.get('/api/productos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM productos_terminados ORDER BY name ASC');
    res.json(result.rows);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

app.get('/', (req, res) => {
  res.send('Servidor del ERP de Crunchy Club corriendo perfectamente.');
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor backend escuchando en el puerto ${PORT}`);
});