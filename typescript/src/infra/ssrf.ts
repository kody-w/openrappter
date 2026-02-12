export interface SSRFValidationResult {
  safe: boolean;
  reason?: string;
}

function isPrivateIP(hostname: string): boolean {
  // IPv4 private ranges
  const ipv4Patterns = [
    /^127\./, // 127.0.0.0/8 (localhost)
    /^10\./, // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
    /^192\.168\./, // 192.168.0.0/16
    /^0\./, // 0.0.0.0/8
    /^169\.254\./, // 169.254.0.0/16 (link-local)
  ];

  for (const pattern of ipv4Patterns) {
    if (pattern.test(hostname)) {
      return true;
    }
  }

  // IPv6 private ranges
  const ipv6Patterns = [
    /^::1$/, // ::1 (localhost)
    /^fe80:/i, // fe80::/10 (link-local)
    /^fc00:/i, // fc00::/7 (unique local)
    /^fd00:/i, // fd00::/8 (unique local)
  ];

  for (const pattern of ipv6Patterns) {
    if (pattern.test(hostname)) {
      return true;
    }
  }

  return false;
}

export function validateUrlForSSRF(url: string): SSRFValidationResult {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  // Block file:// protocol
  if (parsedUrl.protocol === 'file:') {
    return { safe: false, reason: 'file:// protocol is not allowed' };
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  // Block localhost
  if (hostname === 'localhost') {
    return { safe: false, reason: 'localhost is not allowed' };
  }

  // Block *.local domains
  if (hostname.endsWith('.local')) {
    return { safe: false, reason: '.local domains are not allowed' };
  }

  // Check for private IP ranges
  if (isPrivateIP(hostname)) {
    return { safe: false, reason: 'Private IP addresses are not allowed' };
  }

  return { safe: true };
}
