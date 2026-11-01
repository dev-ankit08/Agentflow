import { createHash, createHmac } from "node:crypto";

/** AWS Signature Version 4 (for Bedrock), implemented with node:crypto so no AWS SDK is needed. */
export type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

const sha256 = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 encoding as AWS expects (each path segment / query component). */
const awsEncode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function signRequest(
  req: { method: string; url: string; headers: Record<string, string>; body: string },
  creds: AwsCredentials,
  region: string,
  service: string,
  now = new Date(),
): Record<string, string> {
  const url = new URL(req.url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...req.headers, host: url.host, "x-amz-date": amzDate };
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;

  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]),
  );
  const signedHeaders = Object.keys(lower).sort().join(";");
  const canonicalHeaders = Object.keys(lower)
    .sort()
    .map((k) => `${k}:${lower[k]}\n`)
    .join("");
  const canonicalPath =
    url.pathname
      .split("/")
      .map((seg) => awsEncode(decodeURIComponent(seg)))
      .join("/") || "/";
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [awsEncode(k), awsEncode(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x! < y! ? -1 : 1) : a! < b! ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    req.method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256(req.body),
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, dateStamp), region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
