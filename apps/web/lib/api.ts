export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const retry = response.headers.get('Retry-After');
    throw new ApiError(
      response.status === 429
        ? `Too many requests. Try again in ${retry ?? 'a few'} seconds.`
        : error.error || `Request failed (${response.status})`,
      response.status,
      error.code,
    );
  }
  return response.status === 204 ? null : response.json();
}

export const attachmentUrl = (id: string, download = false) =>
  `${API}/api/attachments/${id}${download ? '?download=1' : ''}`;

export async function uploadAttachment(file: File) {
  const response = await fetch(`${API}/api/attachments`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
    },
    body: file,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status === 413
        ? 'Attachments can be up to 5 MB each.'
        : error.error || 'Upload failed.',
      response.status,
    );
  }
  return (await response.json()) as {
    id: string;
    filename: string;
    contentType: string;
    size: number;
  };
}
