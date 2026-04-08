require('dotenv').config();
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const sharp = require('sharp');
const { createCanvas, loadImage, registerFont } = require('canvas');

registerFont('./Pacifico-Regular.ttf', { family: 'Pacifico' });

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function obtenerCumpleañerosHoy() {
    const hoy = new Date();
    const mesHoy = hoy.getMonth() + 1;
    const diaHoy = hoy.getDate();

    let usuarios = [];
    let start = 0;

    while (true) {
        const response = await axios.post(`${BITRIX_WEBHOOK_URL}user.get`, {
            ACTIVE: true,
            start,
            SELECT: ['ID', 'NAME', 'LAST_NAME', 'PERSONAL_BIRTHDAY', 'PERSONAL_PHOTO']
        });
        const data = response.data;
        usuarios = usuarios.concat(data.result);
        if (!data.next) break;
        start = data.next;
    }

    return usuarios.filter(user => {
        if (!user.PERSONAL_BIRTHDAY) return false;
        const [fecha] = user.PERSONAL_BIRTHDAY.split('T');
        const [, mes, dia] = fecha.split('-').map(Number);
        return mes === mesHoy && dia === diaHoy;
    });
}

async function generarMensaje(nombre) {
    const response = await claude.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 300,
        messages: [{
            role: 'user',
            content: `Genera un mensaje de cumpleaños corporativo para ${nombre}. Debe ser divertido pero profesional, agradecer sus labores y desearle cosas buenas en su vida personal y laboral. Máximo 4 oraciones. Solo el mensaje, sin títulos ni explicaciones.`
        }]
    });
    return response.content[0].text;
}

async function generarFondo() {
    const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt: `Fondo corporativo minimalista para tarjeta de cumpleaños. Color principal azul #007ACC, degradado suave, formas geométricas simples y elegantes, algunos destellos dorados sutiles. Sin personas, sin texto, sin globos. No incluyas ningún texto, letra, número ni símbolo escrito en la imagen.`,
        n: 1,
        size: '1024x1024'
    });
    return response.data[0].url;
}

async function componerImagen(fotoPerfilUrl, fondoUrl) {
    const [fondoBuffer, fotoBuffer] = await Promise.all([
        axios.get(fondoUrl, { responseType: 'arraybuffer' }).then(r => Buffer.from(r.data)),
        axios.get(fotoPerfilUrl.replace(/"/g, ''), { responseType: 'arraybuffer' }).then(r => Buffer.from(r.data))
    ]);

    const TAM = 450;
    const fotoCircular = await sharp(fotoBuffer)
        .resize(TAM, TAM, { fit: 'cover' })
        .composite([{
            input: Buffer.from(`<svg><circle cx="${TAM/2}" cy="${TAM/2}" r="${TAM/2}"/></svg>`),
            blend: 'dest-in'
        }])
        .png()
        .toBuffer();

    const left = Math.round((1024 - TAM) / 2);
    const top = Math.round((1024 - TAM) / 2);

    return sharp(fondoBuffer)
        .resize(1024, 1024)
        .composite([{ input: fotoCircular, left, top }])
        .png()
        .toBuffer();
}

async function agregarTextoArco(imageBuffer, nombre) {
    const img = await loadImage(imageBuffer);
    const canvas = createCanvas(1024, 1024);
    const ctx = canvas.getContext('2d');

    ctx.drawImage(img, 0, 0, 1024, 1024);

    const texto = `¡Feliz Cumpleaños ${nombre.split(' ')[0]}!`;
    const radio = 400;
    const cx = 512;
    const cy = 512;

    ctx.font = 'bold 52px Pacifico';
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#007ACC';
    ctx.lineWidth = 4;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const anchoTotal = ctx.measureText(texto).width;
    const anguloTotal = anchoTotal / radio;
    const anguloInicio = -Math.PI / 2 - anguloTotal / 2;

    ctx.save();
    ctx.translate(cx, cy);
    let anguloActual = anguloInicio;
    for (let i = 0; i < texto.length; i++) {
        const anchoChar = ctx.measureText(texto[i]).width;
        const theta = anguloActual + anchoChar / (2 * radio);
        ctx.save();
        ctx.rotate(theta + Math.PI / 2);
        ctx.translate(0, -radio);
        ctx.strokeText(texto[i], 0, 0);
        ctx.fillText(texto[i], 0, 0);
        ctx.restore();
        anguloActual += anchoChar / radio;
    }
    ctx.restore();

    return canvas.toBuffer('image/png');
}

async function subirImagenBitrix(imageBuffer, nombre) {
    const base64 = imageBuffer.toString('base64');
    const response = await axios.post(`${BITRIX_WEBHOOK_URL}disk.folder.uploadfile`, {
        id: 3,
        fileContent: [`cumple_${nombre}.png`, base64],
        data: { NAME: `cumple_${nombre}.png` },
        generateUniqueName: true
    });
    return response.data.result?.DOWNLOAD_URL;
}

async function publicarCumpleaños(empleado) {
    try {
        const nombre = `${empleado.NAME} ${empleado.LAST_NAME}`.trim();
        console.log(`Generando mensaje e imagen para ${nombre}...`);

        const [textoGenerado, fondoUrl] = await Promise.all([
            generarMensaje(nombre),
            generarFondo()
        ]);

        console.log('Componiendo imagen...');
        const imagenCompuesta = await componerImagen(empleado.PERSONAL_PHOTO, fondoUrl);
        const imagenFinal = await agregarTextoArco(imagenCompuesta, nombre);

        console.log('Subiendo imagen a Bitrix24...');
        const imagenUrl = await subirImagenBitrix(imagenFinal, nombre);

        console.log('Publicando en Bitrix24...');
        const title = encodeURIComponent(`¡Feliz Cumpleaños ${nombre}! 🎂`);
        const message = encodeURIComponent(`${textoGenerado}\n[IMG]${imagenUrl}[/IMG]`);
        const todosResponse = await axios.post(`${BITRIX_WEBHOOK_URL}user.get`, { ACTIVE: true, SELECT: ['ID'] });
        let body = `POST_TITLE=${title}&POST_MESSAGE=${message}`;
        todosResponse.data.result.forEach((u, i) => body += `&DEST[${i}]=U${u.ID}`);

        const bitrixResponse = await axios.post(`${BITRIX_WEBHOOK_URL}log.blogpost.add`, body, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (bitrixResponse.data.result) {
            console.log(`¡Éxito! Post publicado en Bitrix con ID: ${bitrixResponse.data.result}`);
        } else {
            console.error('Respuesta inesperada:', JSON.stringify(bitrixResponse.data));
        }

    } catch (error) {
        if (error.response) {
            console.error('Error de la API:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('Error:', error.message);
        }
    }
}

async function main() {
    try {
        console.log('Buscando cumpleañeros de hoy en Bitrix24...');
        const cumpleañeros = await obtenerCumpleañerosHoy();

        if (cumpleañeros.length === 0) {
            console.log('No hay cumpleañeros hoy.');
            return;
        }

        console.log(`Encontrados ${cumpleañeros.length} cumpleañero(s):`);
        cumpleañeros.forEach(u => console.log(` - ${u.NAME} ${u.LAST_NAME}`));

        for (const empleado of cumpleañeros) {
            await publicarCumpleaños(empleado);
        }

    } catch (error) {
        console.error('Error al obtener usuarios de Bitrix24:', error.message);
    }
}

main();
