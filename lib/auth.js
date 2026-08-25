// Verificação de login (Google) e controlo de acesso às funcionalidades de
// IA, pensado para se ligar mais tarde a subscrições Stripe sem reescrever
// os endpoints — só a função requireEntitledUser() muda nessa altura.
//
// Configuração (variável de ambiente na Vercel): GOOGLE_CLIENT_ID.
// Enquanto não estiver definida, o login NÃO é exigido — mantém-se o
// comportamento atual (acesso livre), para nunca quebrar a app "a meio"
// de uma configuração incompleta. Só depois de:
//   1. criar as credenciais OAuth na Google Cloud Console, e
//   2. definir GOOGLE_CLIENT_ID aqui (servidor) e no index.html (cliente)
// é que o login passa a ser pedido para as funcionalidades de IA.
//
// ALLOWED_EMAILS (opcional, lista separada por vírgulas): se definida, só
// essas contas Google têm acesso — útil para testes fechados com amigos.
// Se não definida, qualquer conta Google autenticada tem acesso (gratuito
// enquanto não houver Stripe ligado).

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

export function authRequired() {
  return !!GOOGLE_CLIENT_ID;
}

// Verifica um ID token do Google Identity Services através do endpoint
// tokeninfo da Google — simples, via fetch, sem bibliotecas de assinatura
// criptográfica. Adequado ao volume de pedidos desta app; para um volume
// muito maior, valeria a pena mudar para validação local via JWKS.
export async function verifyGoogleToken(idToken) {
  if (!idToken) return null;
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (GOOGLE_CLIENT_ID && data.aud !== GOOGLE_CLIENT_ID) return null;
    if (data.email_verified !== 'true' && data.email_verified !== true) return null;
    if (!data.sub || !data.email) return null;
    return { sub: data.sub, email: data.email, name: data.name || data.email, picture: data.picture || '' };
  } catch (e) {
    console.error('Erro ao verificar sessão Google', e);
    return null;
  }
}

export function getBearerToken(req) {
  const header = req.headers['authorization'] || req.headers['Authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

export function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.headers['x-real-ip'] || 'desconhecido';
}

// Devolve { user, error }. `user` é null se não autenticado (e o login não
// era obrigatório) ou se autenticado. `error` é { status, body }, pronto a
// devolver ao cliente, quando o pedido deve ser recusado.
export async function requireEntitledUser(req) {
  if (!authRequired()) {
    return { user: null, error: null };
  }
  const token = getBearerToken(req);
  const user = await verifyGoogleToken(token);
  if (!user) {
    return {
      user: null,
      error: { status: 401, body: { error: 'É preciso iniciar sessão para usar esta funcionalidade.', requiresLogin: true } },
    };
  }
  const allowlist = (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length && !allowlist.includes(user.email.toLowerCase())) {
    return {
      user,
      error: { status: 403, body: { error: 'A tua conta ainda não tem acesso a esta funcionalidade.', requiresLogin: false } },
    };
  }
  return { user, error: null };
}
