import { describe, it, expect } from "vitest";
import { X509Certificate } from "node:crypto";
import { connect, createServer } from "node:tls";
import type { AddressInfo } from "node:net";
import { mintCertificates, SEARCH_CORPUS_HOST } from "../src/search-corpus/x509.js";

// A minimal DER reader, for byte-level checks the X509Certificate API does not expose.
type Node = { tag: number; body: Buffer; raw: Buffer };
function read(buf: Buffer, at = 0): Node & { end: number } {
  const tag = buf[at]!;
  let len = buf[at + 1]!;
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i]!;
    hdr = 2 + n;
  }
  const end = at + hdr + len;
  return { tag, body: buf.subarray(at + hdr, end), raw: buf.subarray(at, end), end };
}
function children(n: Node): Node[] {
  const out: Node[] = [];
  for (let at = 0; at < n.body.length;) {
    const c = read(n.body, at);
    out.push(c);
    at = c.end;
  }
  return out;
}
const oid = (dotted: string) => {
  const p = dotted.split(".").map(Number);
  const bytes = [40 * p[0]! + p[1]!];
  for (const v of p.slice(2)) {
    const b = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) b.unshift((x & 0x7f) | 0x80);
    bytes.push(...b);
  }
  return Buffer.from(bytes);
};
const ECDSA_SHA256 = oid("1.2.840.10045.4.3.2");

function parts(pem: string) {
  const der = new X509Certificate(pem).raw;
  const cert = read(der);
  const [tbs, alg, sig] = children(cert);
  const t = children(tbs!);
  const exts = new Map<string, { critical: boolean; value: Buffer }>();
  const extList = t.find((c) => c.tag === 0xa3);
  for (const e of extList ? children(children(extList)[0]!) : []) {
    const [id, ...rest] = children(e);
    const critical = rest.length === 2 && rest[0]!.tag === 0x01 && rest[0]!.body[0] === 0xff;
    exts.set(id!.body.toString("hex"), { critical, value: rest.at(-1)!.body });
  }
  const ext = (dotted: string) => exts.get(oid(dotted).toString("hex"));
  return { der, tbs: t, alg: alg!, sig: sig!, ext };
}

describe("mintCertificates (an in-repo DER writer: a CA and one leaf for the API host)", () => {
  const m = mintCertificates();
  const ca = new X509Certificate(m.caPem);
  const leaf = new X509Certificate(m.leafPem);

  it("both parse; the leaf verifies against the CA and names the API host", () => {
    expect(SEARCH_CORPUS_HOST).toBe("api.anthropic.com");
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(ca.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkHost(SEARCH_CORPUS_HOST)).toBe(SEARCH_CORPUS_HOST);
    expect(leaf.checkHost("example.com")).toBeUndefined();
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
  });

  it("is valid from five minutes ago for 24 hours", () => {
    const from = Date.parse(leaf.validFrom);
    const to = Date.parse(leaf.validTo);
    expect(Date.now() - from).toBeGreaterThanOrEqual(4 * 60_000);
    expect(Date.now() - from).toBeLessThanOrEqual(6 * 60_000);
    expect(to - from).toBe(24 * 3600_000 + 5 * 60_000);
  });

  it("has the byte-level shape a strict TLS stack wants", () => {
    for (const pem of [m.caPem, m.leafPem]) {
      const p = parts(pem);
      // version [0] EXPLICIT INTEGER 2
      expect(p.tbs[0]!.tag).toBe(0xa0);
      expect(children(p.tbs[0]!)[0]!.raw).toEqual(Buffer.from([0x02, 0x01, 0x02]));
      // a positive, minimally encoded serial of at most 20 bytes
      const serial = p.tbs[1]!;
      expect(serial.tag).toBe(0x02);
      expect(serial.body.length).toBeLessThanOrEqual(20);
      expect(serial.body[0]! & 0x80).toBe(0);
      if (serial.body.length > 1) expect(serial.body[0] === 0 && (serial.body[1]! & 0x80) === 0).toBe(false);
      // ecdsa-with-SHA256 with parameters absent, identical inside and outside the TBS
      expect(children(p.alg).map((c) => c.raw.toString("hex"))).toEqual([
        Buffer.concat([Buffer.from([0x06, ECDSA_SHA256.length]), ECDSA_SHA256]).toString("hex"),
      ]);
      expect(p.tbs[2]!.raw).toEqual(p.alg.raw);
      // UTCTime with seconds
      for (const t of children(p.tbs[4]!)) {
        expect(t.tag).toBe(0x17);
        expect(t.body.toString("latin1")).toMatch(/^\d{12}Z$/);
      }
      // the signature BIT STRING has 0 unused bits and holds an ECDSA-Sig-Value
      expect(p.sig.tag).toBe(0x03);
      expect(p.sig.body[0]).toBe(0);
      const sv = read(p.sig.body.subarray(1));
      expect(sv.tag).toBe(0x30);
      expect(children(sv).map((c) => c.tag)).toEqual([0x02, 0x02]);
    }
    const c = parts(m.caPem);
    const l = parts(m.leafPem);
    // basicConstraints: critical CA:true on the CA, absent on the leaf
    expect(c.ext("2.5.29.19")).toEqual({ critical: true, value: Buffer.from([0x30, 0x03, 0x01, 0x01, 0xff]) });
    expect(l.ext("2.5.29.19")).toBeUndefined();
    // keyUsage: keyCertSign on the CA, digitalSignature on the leaf, both critical
    expect(c.ext("2.5.29.15")).toEqual({ critical: true, value: Buffer.from([0x03, 0x02, 0x02, 0x04]) });
    expect(l.ext("2.5.29.15")).toEqual({ critical: true, value: Buffer.from([0x03, 0x02, 0x07, 0x80]) });
    // the leaf's AKI names the CA's SKI
    const ski = read(c.ext("2.5.29.14")!.value).body;
    const aki = children(read(l.ext("2.5.29.35")!.value))[0]!;
    expect(aki.tag).toBe(0x80);
    expect(aki.body).toEqual(ski);
    // SAN dNSName
    const san = children(read(l.ext("2.5.29.17")!.value));
    expect(san.map((n) => [n.tag, n.body.toString("latin1")])).toEqual([[0x82, SEARCH_CORPUS_HOST]]);
  });

  it("embeds the leaf key's own SPKI", () => {
    const l = parts(m.leafPem);
    expect(l.tbs[6]!.raw).toEqual(leaf.publicKey.export({ type: "spki", format: "der" }));
    expect(parts(m.caPem).tbs[6]!.raw).toEqual(ca.publicKey.export({ type: "spki", format: "der" }));
  });

  it("switches to GeneralizedTime from 2050, so validity never wraps to the 1950s", () => {
    const late = mintCertificates(new Date("2049-12-31T23:55:00Z"));
    const c = new X509Certificate(late.leafPem);
    expect(Date.parse(c.validTo)).toBeGreaterThan(Date.parse(c.validFrom));
    const [from, to] = children(parts(late.leafPem).tbs[4]!);
    expect([from!.tag, to!.tag]).toEqual([0x17, 0x18]);
    expect(to!.body.toString("latin1")).toMatch(/^2050\d{10}Z$/);
  });

  it("mints fresh keys and serials every time", () => {
    const n = mintCertificates();
    expect(n.caPem).not.toBe(m.caPem);
    expect(new X509Certificate(n.leafPem).serialNumber).not.toBe(leaf.serialNumber);
  });

  it("a real TLS handshake trusting only the CA succeeds for the API host", async () => {
    const server = createServer({ key: m.leafKeyPem, cert: m.leafPem }, (s) => s.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const got = await new Promise<string>((resolve, reject) => {
        const s = connect({ host: "127.0.0.1", port, servername: SEARCH_CORPUS_HOST, ca: [m.caPem] }, () => {
          s.setEncoding("utf8");
          let d = "";
          s.on("data", (c) => (d += c));
          s.on("end", () => resolve(d));
        });
        s.on("error", reject);
      });
      expect(got).toBe("ok");
      // and refuses another host name
      await expect(
        new Promise((resolve, reject) => {
          const s = connect({ host: "127.0.0.1", port, servername: "example.com", ca: [m.caPem] }, () => resolve(s.end()));
          s.on("error", reject);
        }),
      ).rejects.toThrow();
    } finally {
      server.close();
    }
  });
});
