/**
 * Certificates for the frozen search corpus's local API endpoint: one CA and one leaf for the API host, minted per
 * run. Node can parse X.509 (`crypto.X509Certificate`) but cannot create one, so this is a minimal DER writer: just
 * the ASN.1 types a v3 certificate needs, signed with ECDSA P-256 over SHA-256. No dependency and no host binary.
 *
 * The shape follows what a strict TLS stack checks: a positive, minimal serial of at most 20 bytes; ecdsa-with-SHA256
 * with its parameters absent, identical inside and outside the TBS; UTCTime with seconds; basicConstraints critical
 * on the CA only; keyUsage critical on both; the leaf's AKI equal to the CA's SKI; a SAN dNSName and serverAuth on the
 * leaf. Valid from five minutes ago (clock skew) for 24 hours.
 */

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

/** The host the agent's API requests go to, and so the leaf's only name. */
export const SEARCH_CORPUS_HOST = "api.anthropic.com";

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const b: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) b.unshift(x & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const explicit = (n: number, inner: Buffer) => tlv(0xa0 | n, inner);
const octets = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
const TRUE = tlv(0x01, Buffer.from([0xff]));

/** A non-negative INTEGER, minimally encoded (a leading 0x00 only when the top bit would read as a sign). */
function integer(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0 && (b[i + 1]! & 0x80) === 0) i++;
  const body = b.subarray(i);
  return tlv(0x02, body[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), body]) : body);
}

function oid(dotted: string): Buffer {
  const p = dotted.split(".").map(Number);
  const out = [40 * p[0]! + p[1]!];
  for (const v of p.slice(2)) {
    const b = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) b.unshift((x & 0x7f) | 0x80);
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, "latin1"));
}

const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), utf8(cn))));
const ext = (id: string, value: Buffer, critical = false) => seq(oid(id), ...(critical ? [TRUE] : []), octets(value));

/** keyUsage bits, DER: trailing zero bits dropped and counted as unused. */
function keyUsage(bit: number): Buffer {
  return bits(Buffer.from([0x80 >> bit]), 7 - bit);
}

function keyId(spki: Buffer): Buffer {
  // RFC 5280 §4.2.1.2 method 1: SHA-1 of the subjectPublicKey bits (an uncompressed P-256 point is the last 65 bytes).
  return createHash("sha1")
    .update(spki.subarray(spki.length - 65))
    .digest();
}

function certificate(a: {
  subject: string;
  issuer: string;
  spki: Buffer;
  extensions: Buffer[];
  signer: KeyObject;
  notBefore: Date;
  notAfter: Date;
}): Buffer {
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f || 0x01; // positive, and never a leading zero byte
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_SHA256,
    name(a.issuer),
    seq(utcTime(a.notBefore), utcTime(a.notAfter)),
    name(a.subject),
    a.spki,
    explicit(3, seq(...a.extensions)),
  );
  return seq(tbs, ECDSA_SHA256, bits(sign("sha256", tbs, a.signer)));
}

const pem = (der: Buffer) =>
  `-----BEGIN CERTIFICATE-----\n${der
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END CERTIFICATE-----\n`;

export type MintedCertificates = { caPem: string; leafPem: string; leafKeyPem: string };

/** A fresh CA and a leaf for `SEARCH_CORPUS_HOST`, signed by it. Only the leaf's key leaves this function. */
export function mintCertificates(now = new Date()): MintedCertificates {
  const notBefore = new Date(now.getTime() - 5 * 60_000);
  const notAfter = new Date(now.getTime() + 24 * 3600_000);
  const ca = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const leaf = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const caSpki = ca.publicKey.export({ type: "spki", format: "der" });
  const leafSpki = leaf.publicKey.export({ type: "spki", format: "der" });
  const caName = "cowork-harness search corpus CA";
  const caDer = certificate({
    subject: caName,
    issuer: caName,
    spki: caSpki,
    signer: ca.privateKey,
    notBefore,
    notAfter,
    extensions: [ext("2.5.29.19", seq(TRUE), true), ext("2.5.29.15", keyUsage(5), true), ext("2.5.29.14", octets(keyId(caSpki)))],
  });
  const leafDer = certificate({
    subject: SEARCH_CORPUS_HOST,
    issuer: caName,
    spki: leafSpki,
    signer: ca.privateKey,
    notBefore,
    notAfter,
    extensions: [
      ext("2.5.29.15", keyUsage(0), true),
      ext("2.5.29.37", seq(oid("1.3.6.1.5.5.7.3.1"))),
      ext("2.5.29.17", seq(tlv(0x82, Buffer.from(SEARCH_CORPUS_HOST, "latin1")))),
      ext("2.5.29.14", octets(keyId(leafSpki))),
      ext("2.5.29.35", seq(tlv(0x80, keyId(caSpki)))),
    ],
  });
  return {
    caPem: pem(caDer),
    leafPem: pem(leafDer),
    leafKeyPem: leaf.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}
