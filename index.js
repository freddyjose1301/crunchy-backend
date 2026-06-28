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
app.get('/api/auth/login-options', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM authenticators WHERE user_id = 'user_crunchy_master' LIMIT 1");
    if (result.rows.length === 0) return res.status(404).json({ error: 'No hay huellas registradas en la base de datos.' });

    // En la v10, el ID para verificar debe ser un string Base64URL limpio
    const allowCredentials = result.rows.map(row => {
      const idBase64URL = row.id.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      return {
        id: idBase64URL,
        type: 'public-key',
        transports: ['internal'],
      };
    });

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification: 'preferred',
    });

    currentChallenge = options.challenge;
    res.json(options);
  } catch (error) {
    console.error(error);
    // Ahora enviamos el error real al celular si algo explota
    res.status(500).json({ error: 'Error del servidor (options): ' + error.message });
  }
});

// 5. Recibir la firma de la huella y dejar entrar al usuario
app.post('/api/auth/login-verify', async (req, res) => {
  const { body } = req;
  try {
    const result = await pool.query("SELECT * FROM authenticators WHERE user_id = 'user_crunchy_master' LIMIT 1");
    const authenticator = result.rows[0];

    // Formateamos las llaves a como las exige la nueva versión
    const idBase64URL = authenticator.id.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const publicKeyUint8 = new Uint8Array(Buffer.from(authenticator.public_key, 'base64'));

    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: currentChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      authenticator: {
        credentialID: idBase64URL, 
        credentialPublicKey: publicKeyUint8, 
        counter: parseInt(authenticator.counter),
      },
    });

    if (verification.verified) {
      await pool.query('UPDATE authenticators SET counter = $1 WHERE id = $2', [
        verification.authenticationInfo.newCounter,
        authenticator.id
      ]);
      res.json({ verified: true });
    } else {
      res.status(400).json({ verified: false, error: 'Firma biométrica rechazada por el chip.' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error interno de validación: ' + error.message });
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

// ==========================================
// MÓDULO BIOMÉTRICO (WEBAUTHN - REGISTRO)
// ==========================================

// 1. Generar opciones para que el teléfono encienda el lector de huellas
// 1. Generar opciones para que el teléfono encienda el lector de huellas
app.get('/api/auth/register-options', async (req, res) => {
  try {
    const userOptions = await generateRegistrationOptions({
      rpName,
      rpID,
      // EL CAMBIO VITAL ESTÁ EN ESTA LÍNEA (Uint8Array)
      userID: new Uint8Array(Buffer.from('user_crunchy_master')), 
      userName: 'freddyjose13',
      userDisplayName: 'Freddy Villegas',
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
        authenticatorAttachment: 'platform', 
      },
    });

    currentChallenge = userOptions.challenge;
    res.json(userOptions);
  } catch (error) {
    console.error(error);
    // Ahora enviamos el mensaje de error para saber qué pasa
    res.status(500).json({ error: 'Error del servidor: ' + error.message }); 
  }
});
// 2. Recibir la clave pública del teléfono y guardarla en PostgreSQL
// 2. Recibir la clave pública del teléfono y guardarla en PostgreSQL
app.post('/api/auth/register-verify', async (req, res) => {
  const { body } = req;

  console.log("➡️ Iniciando verificación criptográfica de la huella...");
  console.log("Desafío en memoria del servidor:", currentChallenge);

  try {
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: currentChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    const { verified, registrationInfo } = verification;

if (verified && registrationInfo) {
      // Ajuste clave para soportar la nueva versión 10 de @simplewebauthn
      const credentialInfo = registrationInfo.credential || registrationInfo;
      
      const id = credentialInfo.id || credentialInfo.credentialID;
      const publicKey = credentialInfo.publicKey || credentialInfo.credentialPublicKey;
      const counter = credentialInfo.counter;

      // Convertir la clave pública y el ID a base64 para PostgreSQL
      const credentialIdBase64 = Buffer.from(id).toString('base64');
      const publicKeyBase64 = Buffer.from(publicKey).toString('base64');

      await pool.query(
        'INSERT INTO authenticators (id, user_id, public_key, counter, device_type) VALUES ($1, $2, $3, $4, $5)',
        [credentialIdBase64, 'user_crunchy_master', publicKeyBase64, counter, 'internal_biometric']
      );

      console.log("✅ Dispositivo verificado e insertado en PostgreSQL.");
      res.json({ verified: true, message: '¡Huella dactilar vinculada con éxito!' });
    } else {
      // Si la librería dice 'verified: false', imprimimos el objeto completo para ver qué falló
      console.error("❌ La librería rechazó la firma. Detalles:", verification);
      res.status(400).json({ 
        verified: false, 
        error: 'Falla de coincidencia criptográfica (Origen o Desafío inválido).' 
      });
    }
  } catch (error) {
    // Si la validación revienta por un error de estructura
    console.error("❌ Error crítico en el proceso de verificación:", error.message);
    res.status(500).json({ error: 'Error interno del validador: ' + error.message });
  }
});

// En crunchy-backend/index.js

// 3. Verificar si el usuario ya tiene una huella vinculada
app.get('/api/auth/check-biometric', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) FROM authenticators WHERE user_id = $1', 
      ['user_crunchy_master']
    );
    const hasFingerprint = parseInt(result.rows[0].count) > 0;
    res.json({ linked: hasFingerprint });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error al verificar estatus biométrico' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor backend escuchando en el puerto ${PORT}`);
});