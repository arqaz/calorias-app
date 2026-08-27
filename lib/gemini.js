// Wrapper único para chamar o Gemini a partir dos vários endpoints de IA da
// app — antes, cada endpoint repetia o mesmo fetch/parsing e, mais
// importante, não tinha qualquer tolerância a falhas temporárias da API
// (sobrecarga do modelo, limite de pedidos do lado da Google): um erro 503
// "temporarily overloaded" aparecia à pessoa como um erro técnico em bruto,
// em inglês, com o JSON da resposta da Google incluído. Este wrapper tenta
// de novo automaticamente nesses casos e, se mesmo assim falhar, devolve
// sempre uma mensagem já pronta a mostrar, em português.
//
// Nota importante sobre tempos: as funções serverless da Vercel têm um
// limite de execução (ver vercel.json, maxDuration). Cada tentativa tem um
// limite próprio (TIMEOUT_MS, via AbortController) para nunca ficar
// pendurada à espera de uma resposta que nunca chega — sem isto, uma
// chamada lenta ao Gemini, multiplicada por retentativas, podia ultrapassar
// o limite da função e deixar o pedido "preso" no cliente sem resposta
// nenhuma (nem sequer um erro), em vez de falhar de forma limpa.

const MODEL = 'gemini-flash-latest';
const TIMEOUT_MS = 9000;

function isRetryableStatus(httpStatus, parsedBody) {
  if (httpStatus === 503 || httpStatus === 429) return true;
  const status = parsedBody?.error?.status;
  return status === 'UNAVAILABLE' || status === 'RESOURCE_EXHAUSTED';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function overloadedError() {
  const err = new Error('O serviço de IA está sobrecarregado neste momento. Tenta novamente daqui a pouco.');
  err.status = 502;
  return err;
}

// `parts` segue o formato de conteúdo do Gemini: array de { text } e/ou
// { inlineData: { mimeType, data } }. Devolve o objeto já parseado a partir
// do JSON que o modelo devolveu (responseMimeType: 'application/json').
//
// Em caso de erro, lança sempre um Error com `.status` (código HTTP a
// devolver ao cliente) e uma `.message` já pronta a mostrar à pessoa, em
// português — nunca expõe o corpo técnico da resposta da Google.
//
// maxRetries por omissão é 1 (2 tentativas no total) — de propósito baixo,
// para o pior caso (2 tentativas × TIMEOUT_MS + um pequeno intervalo) ficar
// bem dentro do limite de execução da função, mesmo somado ao resto do
// trabalho do endpoint (autenticação, limite de pedidos).
export async function callGeminiJSON({ apiKey, parts, temperature = 0.5, maxRetries = 1, timeoutMs = TIMEOUT_MS }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature, responseMimeType: 'application/json' },
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let apiResponse;
    try {
      apiResponse = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal });
    } catch (networkErr) {
      const isTimeout = networkErr?.name === 'AbortError';
      if (attempt < maxRetries) { await sleep(500); continue; }
      console.error(isTimeout ? 'O Gemini não respondeu a tempo.' : 'Falha de rede a contactar o Gemini:', networkErr);
      throw isTimeout ? overloadedError() : Object.assign(new Error('Não foi possível contactar o serviço de IA. Tenta novamente.'), { status: 502 });
    } finally {
      clearTimeout(timeoutId);
    }

    if (apiResponse.ok) {
      const data = await apiResponse.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        const err = new Error('O serviço de IA não devolveu uma resposta válida. Tenta novamente.');
        err.status = 502;
        throw err;
      }
      const clean = text
        .trim()
        .replace(/^```json/i, '')
        .replace(/^```/, '')
        .replace(/```$/, '')
        .trim();
      try {
        return JSON.parse(clean);
      } catch (parseErr) {
        console.error('Falha a interpretar resposta do Gemini como JSON:', clean);
        const err = new Error('O serviço de IA devolveu uma resposta inesperada. Tenta novamente.');
        err.status = 502;
        throw err;
      }
    }

    const errText = await apiResponse.text();
    let parsedBody = null;
    try { parsedBody = JSON.parse(errText); } catch (e) { /* corpo não era JSON */ }

    if (isRetryableStatus(apiResponse.status, parsedBody)) {
      if (attempt < maxRetries) {
        await sleep(500);
        continue;
      }
      console.error('Gemini continua sobrecarregado após retentativas:', apiResponse.status, errText);
      throw overloadedError();
    }

    console.error('Erro na API do Gemini:', apiResponse.status, errText);
    const err = new Error('Erro ao contactar o serviço de IA. Tenta novamente.');
    err.status = 502;
    throw err;
  }
}
