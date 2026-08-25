// Recebe a confirmação de login do fluxo de redireccionamento (ux_mode:
// 'redirect') do Google Identity Services — a alternativa ao fluxo de
// pop-up, usada porque em apps instaladas como PWA a Google não consegue
// mostrar um seletor de conta nativo (nem em pop-up nem via FedCM) e cai
// sempre num separador à parte com o conteúdo pequeno e pouco legível.
// Com o modo de redireccionamento, o ecrã da Google ocupa a página toda
// em vez de simular uma janela pop-up.
//
// A Google faz aqui um POST application/x-www-form-urlencoded com o token
// de sessão (credential) e um token contra CSRF (g_csrf_token) — que
// também vem como cookie definido no nosso domínio nesse mesmo pedido.
// Confirmamos que os dois coincidem antes de aceitar, tal como a
// documentação da Google pede, e depois redirecionamos de volta para a
// app com o token no fragmento do URL (#gtoken=...). O fragmento nunca
// chega ao servidor em pedidos seguintes — só o código do lado do
// cliente o lê, para o guardar tal como já fazia no fluxo de pop-up.

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const cookies = parseCookies(req.headers.cookie);
  const bodyToken = body.g_csrf_token;
  const cookieToken = cookies.g_csrf_token;
  const credential = body.credential;

  if (!bodyToken || !cookieToken || bodyToken !== cookieToken || !credential) {
    res.writeHead(302, { Location: '/#gtoken_error=1' });
    res.end();
    return;
  }

  res.writeHead(302, { Location: '/#gtoken=' + encodeURIComponent(credential) });
  res.end();
}
