import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openIndexDb, closeIndexDb, getIndexDb } from "./storage/index-db.js";

let originalDataDir: string | undefined;
let tempDataDir: string | undefined;

export function setupTestDataDir(): string {
	originalDataDir = process.env.GENISYS_DATA_DIR;
	// Close any previously cached db so we can reopen with a new path
	closeIndexDb();
	tempDataDir = mkdtempSync(join(tmpdir(), "genisys-test-"));
	process.env.GENISYS_DATA_DIR = tempDataDir;
	openIndexDb();
	return tempDataDir;
}

export function teardownTestDataDir(): void {
	closeIndexDb();
	if (tempDataDir) {
		try {
			rmSync(tempDataDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		tempDataDir = undefined;
	}
	if (originalDataDir !== undefined) {
		process.env.GENISYS_DATA_DIR = originalDataDir;
	} else {
		delete process.env.GENISYS_DATA_DIR;
	}
}

export function clearIndexDb(): void {
	const db = getIndexDb();
	db.exec("DELETE FROM agents");
	db.exec("DELETE FROM rooms");
}
