import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["src/renderer/src/assets/mc/block/water_flow.png", "src/renderer/src/assets/mc/block/water_still.png"];

function tintPixel(gray) {
	const t = gray / 255;
	// MC-style water: deep blue base, brighter cyan highlights
	return {
		r: Math.round(12 + t * 78),
		g: Math.round(58 + t * 142),
		b: Math.round(128 + t * 127)
	};
}

for (const rel of files) {
	const file = path.join(root, rel);
	const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	for (let i = 0; i < data.length; i += info.channels) {
		const gray = data[i];
		const { r, g, b } = tintPixel(gray);
		data[i] = r;
		data[i + 1] = g;
		data[i + 2] = b;
		if (info.channels === 4) data[i + 3] = 255;
	}
	await sharp(data, {
		raw: { width: info.width, height: info.height, channels: info.channels }
	})
		.png()
		.toFile(file);
	console.log(`tinted ${rel} (${info.width}x${info.height})`);
}
