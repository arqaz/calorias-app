// Cliente mínimo para um armazenamento chave-valor compatível com a API REST
// da Upstash — sem dependências npm, só fetch, para se manter consistente
// com o resto do projeto.
//
// Configuração (variáveis de ambiente na Vercel): ligar uma base de dados
// Redis/KV ao projeto (Vercel → Storage → Upstash) injeta automaticamente
// as variáveis necessárias. O nome exato varia consoante a integração —
// aceitamos as duas convenções mais comuns (KV_REST_API_* da antiga Vercel
// KV nativa, e UPSTASH_REDIS_REST_* da integração atual via marketplace),
// para não depender de adivinhar qual foi usada.
//
// Enquanto não estiverem configuradas, todas as funções aqui falham em
// "aberto" — ou seja, o limite de pedidos fica inativo, mas a app continua
// a funcionar normalmente. É uma proteção extra, nunca deve deitar a app
// abaixo por si só.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export function kvConfigured() {
  return !!(KV_URL && KV_TOKEN);
}

async function kvCommand(...command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data ? data.result : null;
}

// Limite de pedidos por janela fixa: incrementa um contador (INCR) e define
// a expiração da janela na primeira chamada de cada período.
export async function checkRateLimit(key, limit, windowSeconds) {
  if (!kvConfigured()) return { allowed: true, remaining: limit };
  try {
    const count = await kvCommand('INCR', key);
    if (count === 1) {
      await kvCommand('EXPIRE', key, windowSeconds);
    }
    if (count == null) return { allowed: true, remaining: limit };
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  } catch (e) {
    console.error('Erro no limite de pedidos (rate limit)', e);
    return { allowed: true, remaining: limit };
  }
}

export async function kvGetJSON(key) {
  if (!kvConfigured()) return null;
  try {
    const raw = await kvCommand('GET', key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export async function kvSetJSON(key, value) {
  if (!kvConfigured()) return false;
  try {
    await kvCommand('SET', key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('Erro ao guardar no KV', e);
    return false;
  }
}
