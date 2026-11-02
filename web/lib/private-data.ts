/**
 * Server-only: where the services keep their data on this (self-hosted) machine, and the owner's
 * supplier directory. Read at request time only, by endpoints that check the owner's session first.
 */
import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Directory } from "@getleash/shared";

import { NETWORK } from "./config";

export function dataBase(): string {
  return resolve(/*turbopackIgnore: true*/ process.env.GETLEASH_DATA_DIR ?? resolve(process.cwd(), "..", ".data"), NETWORK);
}

/** GETLEASH_DIRECTORY_BASE64 (hosts without the owner's files, such as Vercel), else the directory file. */
export function readDirectory(): Directory {
  const encoded = process.env.GETLEASH_DIRECTORY_BASE64;
  if (encoded) return Directory.parse(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
  const file = process.env.GETLEASH_DIRECTORY ?? resolve(/*turbopackIgnore: true*/ dataBase(), "directory.json");
  return existsSync(file) ? Directory.parse(JSON.parse(readFileSync(file, "utf8"))) : { suppliers: [] };
}
