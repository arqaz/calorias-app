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
const TIMEOUT_MS = 7000;

// Um 429 da Google pode ser transitório (limite de pedidos por
// minuto/segundo — vale a pena tentar de novo daqui a pouco) ou não (quota
// diária esgotada, OU — como se confirmou numa conta real desta app — um
// limite de GASTO MENSAL configurado em Google AI Studio já atingido, que só
// é reposto no dia 1 do mês seguinte). Retentar não ajuda em nenhum dos
// casos não transitórios, e prometer "tenta amanhã" seria errado no caso do
// limite mensal — por isso a mensagem, abaixo, não assume qual dos dois é.
//
// O sinal mais fiável para distinguir os dois casos não é o texto da quota
// (o nome exato varia — "PerDay", limites de gasto, etc.) mas sim a
// presença de um "RetryInfo" na resposta: a Google inclui isto quando faz
// sentido tentar de novo num curto espaço de tempo; num limite esgotado
// (diário ou de gasto), não há isso a sugerir, porque não há um tempo curto
// que resolva o problema.
function classify(httpStatus, parsedBody) {
  const status = parsedBody?.error?.status;
  if (httpStatus === 503 || status === 'UNAVAILABLE') {
    return { retryable: true, kind: 'overloaded' };
  }
  if (httpStatus === 429 || status === 'RESOURCE_EXHAUSTED') {
    const details = parsedBody?.error?.details || [];
    const hasRetryInfo = details.some((d) => String(d?.['@type'] || '').includes('RetryInfo'));
    const quotaFailure = details.find((d) => String(d?.['@type'] || '').includes('QuotaFailure'));
    const mentionsPerDay = (quotaFailure?.violations || []).some((v) =>
      /perday/i.test(v?.quotaId || '') || /perday/i.test(v?.quotaMetric || '')
    );
    // Não transitório se a Google não sugeriu um tempo de espera curto, ou
    // se a quota excedida é explicitamente diária.
    const isExhausted = !hasRetryInfo || mentionsPerDay;
    return isExhausted ? { retryable: false, kind: 'quota_exhausted' } : { retryable: true, kind: 'rate_limited' };
  }
  return { retryable: false, kind: 'other' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorFor(kind) {
  const messages = {
    overloaded: 'O serviço de IA está sobrecarregado neste momento. Tenta novamente daqui a pouco.',
    rate_limited: 'O serviço de IA está sobrecarregado neste momento. Tenta novamente daqui a pouco.',
    quota_exhausted: 'Foi atingido o limite de utilização da IA configurado na conta (quota ou limite de gasto). Verifica em Google AI Studio → Limite de taxa / Gasto.',
    other: 'Erro ao contactar o serviço de IA. Tenta novamente.',
  };
  const err = new Error(messages[kind] || messages.other);
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
// maxRetries por omissão é 2 (3 tentativas no total) — no pior caso
// (3 tentativas × TIMEOUT_MS + dois pequenos intervalos ≈ 22s) fica com
// margem confortável dentro do limite de execução da função (30s, ver
// vercel.json), mesmo somado ao resto do trabalho do endpoint
// (autenticação, limite de pedidos). Congestões reais do Gemini já vistas
// em produção por vezes ultrapassam 2 tentativas — daí o valor mais alto.
// Uma quota/limite de gasto esgotado (ver classify()) nunca é retentado,
// mesmo que haja tentativas por gastar — retentar não muda o resultado.
export async function callGeminiJSON({ apiKey, parts, temperature = 0.5, maxRetries = 2, timeoutMs = TIMEOUT_MS }) {
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
      throw isTimeout ? errorFor('overloaded') : Object.assign(new Error('Não foi possível contactar o serviço de IA. Tenta novamente.'), { status: 502 });
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

    const { retryable, kind } = classify(apiResponse.status, parsedBody);

    if (retryable && attempt < maxRetries) {
      await sleep(500);
      continue;
    }

    if (kind === 'quota_exhausted') {
      console.error('Quota/limite de gasto do Gemini esgotado:', apiResponse.status, errText);
    } else if (retryable) {
      console.error('Gemini continua sobrecarregado após retentativas:', apiResponse.status, errText);
    } else {
      console.error('Erro na API do Gemini:', apiResponse.status, errText);
    }
    throw errorFor(kind);
  }
}
