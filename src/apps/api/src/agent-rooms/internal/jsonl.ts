import { StringDecoder } from "string_decoder";

export function attachJsonlReader(
	stream: NodeJS.ReadableStream,
	onLine: (line: string) => void,
): void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	stream.on("data", (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;

			let line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);

			if (line.endsWith("\r")) {
				line = line.slice(0, -1);
			}

			if (line.length > 0) onLine(line);
		}
	});

	stream.on("end", () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
			if (line.length > 0) onLine(line);
		}
	});
}
