import { crc32, deflateSync, inflateSync } from "node:zlib";
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from "@cantoo/pdf-lib";
import sharp from "sharp";

const MIN_IMAGE_BYTES = 64 * 1024;
const MAX_IMAGE_SIDE = 2400;
const JPEG_QUALITY = 75;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const name = PDFName.of;
const latin1 = new TextDecoder("latin1");
const prunedGroups = new Set(["XObject", "Font", "ExtGState", "Pattern", "Shading", "ColorSpace", "Properties"].map(name));

const numberOf = (dict, key, fallback) => {
    const value = dict?.lookup(name(key));
    return value instanceof PDFNumber ? value.asNumber() : fallback;
};

function pngChunk(type, data) {
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length);
    chunk.write(type, 4, "latin1");
    chunk.set(data, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)), data.length + 8);

    return chunk;
}

function colorComponents(dict) {
    const space = dict.lookup(name("ColorSpace"));

    if (space === name("DeviceRGB")) return 3;
    if (space === name("DeviceGray")) return 1;

    if (space instanceof PDFArray && space.lookup(0) === name("ICCBased")) {
        const components = numberOf(space.lookup(1)?.dict, "N", 0);
        return components === 1 || components === 3 ? components : null;
    }

    return null;
}

// Returns the image as JPEG or PNG bytes that sharp can decode, or null when it is not supported.
function encodedImage(dict, contents) {
    const filters = dict.lookup(name("Filter"));
    const filter = filters instanceof PDFArray ? (filters.size() === 1 ? filters.lookup(0) : null) : filters;
    const components = colorComponents(dict);

    if (!components || dict.has(name("Decode")) || filter === null) {
        return null;
    }

    if (filter === name("DCTDecode")) {
        return contents;
    }

    if ((filter && filter !== name("FlateDecode")) || numberOf(dict, "BitsPerComponent", 0) !== 8) {
        return null;
    }

    const width = numberOf(dict, "Width", 0);
    const height = numberOf(dict, "Height", 0);
    const rowBytes = width * components;
    const parms = dict.lookup(name("DecodeParms"));
    const params = parms instanceof PDFArray ? parms.lookup(0) : parms;
    const predictor = numberOf(params, "Predictor", 1);
    let idat;

    if (filter && predictor >= 10) {
        // PNG predictors: the Flate data already is a PNG IDAT stream.
        const matches = numberOf(params, "Colors", 1) === components
            && numberOf(params, "BitsPerComponent", 8) === 8
            && numberOf(params, "Columns", 1) === width;

        if (!matches) return null;
        idat = contents;
    }
    else if (predictor === 1) {
        const pixels = filter ? inflateSync(contents) : contents;
        if (pixels.length < rowBytes * height) return null;

        const rows = Buffer.alloc((rowBytes + 1) * height);
        for (let row = 0; row < height; row++) {
            rows.set(pixels.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1);
        }

        idat = deflateSync(rows, { level: 1 });
    }
    else {
        return null;
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = components === 3 ? 2 : 0;

    return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array())]);
}

export async function openPdf(data) {
    try {
        return await PDFDocument.load(data, { password: "", updateMetadata: false });
    }
    catch (error) {
        throw new Error(/password/i.test(error.message)
            ? "Password-protected PDFs are not supported."
            : `The file is not a valid PDF document (${error.message}).`);
    }
}

export async function compressImages(doc) {
    let images = 0;
    let saved = 0;

    for (const [, object] of doc.context.enumerateIndirectObjects()) {
        if (!(object instanceof PDFRawStream) || object.dict.lookup(name("Subtype")) !== name("Image")) {
            continue;
        }

        const { dict, contents } = object;

        if (contents.length < MIN_IMAGE_BYTES || dict.lookup(name("ImageMask")) === PDFBool.True) {
            continue;
        }

        try {
            const source = encodedImage(dict, contents);
            if (!source) continue;

            const { data: jpeg, info: image } = await sharp(source)
                .resize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE, { fit: "inside", withoutEnlargement: true })
                .jpeg({ quality: JPEG_QUALITY })
                .toBuffer({ resolveWithObject: true });

            if (jpeg.length >= contents.length * 0.8) continue;

            saved += contents.length - jpeg.length;
            object.updateContents(jpeg);
            dict.set(name("Filter"), name("DCTDecode"));
            dict.set(name("ColorSpace"), name("DeviceRGB"));
            dict.set(name("Width"), PDFNumber.of(image.width));
            dict.set(name("Height"), PDFNumber.of(image.height));
            dict.set(name("BitsPerComponent"), PDFNumber.of(8));
            dict.delete(name("DecodeParms"));
            images++;
        }
        catch {
            continue;
        }
    }

    return { images, saved };
}

export async function splitPages(doc, onProgress) {
    const total = doc.getPageCount();
    const pages = [];

    for (let index = 0; index < total; index++) {
        const leaf = doc.getPage(index).node;
        const ownResources = leaf.get(name("Resources"));

        try {
            // Keep only the resources the page content uses, so pages of documents that share one
            // resource dictionary across all pages do not carry every image and font of the file.
            try {
                const contents = leaf.Contents();
                const streams = contents instanceof PDFArray ? contents.asArray().map(ref => doc.context.lookup(ref)) : [contents];
                const used = new Set(streams.map(stream => latin1.decode(decodePDFRawStream(stream).decode())).join("\n").match(/\/[^\s/[\]()<>{}%]+/g));
                const resources = leaf.Resources();
                const pruned = doc.context.obj({});

                for (const [key, value] of resources?.entries() ?? []) {
                    const group = prunedGroups.has(key) ? resources.lookup(key) : null;

                    if (!(group instanceof PDFDict)) {
                        pruned.set(key, value);
                        continue;
                    }

                    const kept = doc.context.obj({});
                    group.entries().filter(([entry]) => used.has(entry.asString())).forEach(([entry, ref]) => kept.set(entry, ref));
                    pruned.set(key, kept);
                }

                if (resources) leaf.set(name("Resources"), pruned);
            }
            catch { }

            const single = await PDFDocument.create({ updateMetadata: false });
            const [page] = await single.copyPages(doc, [index]);
            single.addPage(page);
            pages.push({ page: index + 1, bytes: await single.save({ useObjectStreams: true }), error: null });
        }
        catch (error) {
            pages.push({ page: index + 1, bytes: null, error: `Split failed: ${error.message}` });
        }
        finally {
            if (ownResources) leaf.set(name("Resources"), ownResources);
            else leaf.delete(name("Resources"));
        }

        onProgress(index + 1, total);
    }

    return pages;
}
