require('dotenv').config();
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const sharp = require('sharp');
const { createCanvas, loadImage, registerFont } = require('canvas');

registerFont('./Pacifico-Regular.ttf', { family: 'Pacifico' });

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30000 });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LOGOS_POR_DOMINIO = {
    'myhealthprograms': 'https://cdn.bitrix24.com/b21945603/landing/d5a/d5a5cc8c028f267237d646cd2a90473b/dise_o_sin_t_tulo_4_1x_1x.png',
    'ensuritygroup':    'https://cdn.bitrix24.com/b21945603/landing/898/8989ac3a7b465689d46cb6fd83474a26/Logo_Ensurity_Group_1080_500_px_1x.png',
    'egconnects':       'https://cdn.bitrix24.com/b21945603/landing/37d/37de78de37b7f13e5af735d1e1a6532f/Untitled_180_60_px_1_1x.png'
};

async function obtenerCumpleañerosPorFecha(fecha) {
    const mes = fecha.getMonth() + 1;
    const dia = fecha.getDate();

    let usuarios = [];
    let start = 0;

    while (true) {
        const response = await axios.post(`${BITRIX_WEBHOOK_URL}user.get`, {
            ACTIVE: true,
            start,
            SELECT: ['ID', 'NAME', 'LAST_NAME', 'PERSONAL_BIRTHDAY', 'PERSONAL_PHOTO', 'EMAIL']
        });
        const data = response.data;
        usuarios = usuarios.concat(data.result);
        if (!data.next) break;
        start = data.next;
    }

    return usuarios.filter(user => {
        if (!user.PERSONAL_BIRTHDAY) return false;
        const [fechaStr] = user.PERSONAL_BIRTHDAY.split('T');
        const [, mesBD, diaBD] = fechaStr.split('-').map(Number);
        return mesBD === mes && diaBD === dia;
    });
}

function obtenerUrlLogoPorEmail(email) {
    if (!email) return null;
    const dominio = email.split('@')[1]?.toLowerCase() || '';
    for (const [key, url] of Object.entries(LOGOS_POR_DOMINIO)) {
        if (dominio.includes(key)) return url;
    }
    return null;
}

async function generarMensaje(nombre, contextoFDS = null) {
    const prompt = contextoFDS
        ? `Genera un mensaje de cumpleaños corporativo para ${nombre}. Su cumpleaños fue el ${contextoFDS} pasado, hoy lunes lo estamos celebrando. El mensaje debe estar en tiempo pasado mencionando que cumplió años el ${contextoFDS}, ser divertido pero profesional, agradecer sus labores y desearle cosas buenas en su vida personal y laboral. Máximo 4 oraciones. Solo el mensaje, sin títulos ni explicaciones.`
        : `Genera un mensaje de cumpleaños corporativo para ${nombre}. Debe ser divertido pero profesional, agradecer sus labores y desearle cosas buenas en su vida personal y laboral. Máximo 4 oraciones. Solo el mensaje, sin títulos ni explicaciones.`;

    const response = await claude.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
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

async function componerImagen(fotoPerfilUrl, fondoUrl, logoUrl = null) {
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

    const composites = [{ input: fotoCircular, left, top }];

    if (logoUrl) {
        const logoBuffer = await axios.get(logoUrl, { responseType: 'arraybuffer' }).then(r => Buffer.from(r.data));
        const logoResized = await sharp(logoBuffer)
            .resize(280, 90, { fit: 'inside' })
            .png()
            .toBuffer();
        const { width: logoW, height: logoH } = await sharp(logoResized).metadata();
        composites.push({
            input: logoResized,
            left: Math.round((1024 - logoW) / 2),
            top: 1024 - logoH - 35
        });
    }

    return sharp(fondoBuffer)
        .resize(1024, 1024)
        .composite(composites)
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

async function publicarCumpleaños(empleado, contextoFDS = null) {
    try {
        const nombre = `${empleado.NAME} ${empleado.LAST_NAME}`.trim();
        console.log(`Generando mensaje e imagen para ${nombre}${contextoFDS ? ` (cumpleaños del ${contextoFDS})` : ''}...`);

        const logoUrl = obtenerUrlLogoPorEmail(empleado.EMAIL);
        if (logoUrl) console.log(`Logo encontrado para dominio: ${empleado.EMAIL?.split('@')[1]}`);
        else console.log(`Sin logo para el correo: ${empleado.EMAIL}`);

        const [textoGenerado, fondoUrl] = await Promise.all([
            generarMensaje(nombre, contextoFDS),
            generarFondo()
        ]);

        console.log('Componiendo imagen...');
        const imagenCompuesta = await componerImagen(empleado.PERSONAL_PHOTO, fondoUrl, logoUrl);
        const imagenFinal = await agregarTextoArco(imagenCompuesta, nombre);

        console.log('Subiendo imagen a Bitrix24...');
        const imagenUrl = await subirImagenBitrix(imagenFinal, nombre);

        console.log('Publicando en Bitrix24...');
        const title = encodeURIComponent(
            contextoFDS
                ? `🎂 Celebramos el cumpleaños de ${nombre} (el ${contextoFDS} pasado)`
                : `¡Feliz Cumpleaños ${nombre}! 🎂`
        );
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
        const hoy = new Date();
        const diaSemana = hoy.getDay(); // 0=Dom, 1=Lun, ..., 6=Sáb

        if (diaSemana === 0 || diaSemana === 6) {
            console.log('Hoy es fin de semana. No se publican felicitaciones.');
            return;
        }

        const tareas = [];

        // Cumpleaños de hoy (mensaje en presente)
        console.log('Buscando cumpleañeros de hoy en Bitrix24...');
        const cumpleHoy = await obtenerCumpleañerosPorFecha(hoy);
        cumpleHoy.forEach(e => tareas.push({ empleado: e, contextoFDS: null }));

        // Si es lunes, también buscar sábado y domingo anteriores
        if (diaSemana === 1) {
            const sabado = new Date(hoy);
            sabado.setDate(hoy.getDate() - 2);
            const domingo = new Date(hoy);
            domingo.setDate(hoy.getDate() - 1);

            console.log('Es lunes: buscando cumpleañeros del fin de semana...');
            const [cumpleSabado, cumpleDomingo] = await Promise.all([
                obtenerCumpleañerosPorFecha(sabado),
                obtenerCumpleañerosPorFecha(domingo)
            ]);

            cumpleSabado.forEach(e => tareas.push({ empleado: e, contextoFDS: 'sábado' }));
            cumpleDomingo.forEach(e => tareas.push({ empleado: e, contextoFDS: 'domingo' }));
        }

        if (tareas.length === 0) {
            console.log('No hay cumpleañeros para publicar.');
            return;
        }

        console.log(`Publicando ${tareas.length} felicitación(es):`);
        tareas.forEach(({ empleado, contextoFDS }) =>
            console.log(` - ${empleado.NAME} ${empleado.LAST_NAME}${contextoFDS ? ` (cumpleaños del ${contextoFDS})` : ''}`)
        );

        for (const { empleado, contextoFDS } of tareas) {
            await publicarCumpleaños(empleado, contextoFDS);
        }

    } catch (error) {
        console.error('Error al obtener usuarios de Bitrix24:', error.message);
    }
}

main();
