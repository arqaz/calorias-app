import { requireEntitledUser, getClientIp } from '../lib/auth.js';
import { checkRateLimit } from '../lib/kv.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  const { user, error: authError } = await requireEntitledUser(req);
  if (authError) {
    res.status(authError.status).json(authError.body);
    return;
  }
  // Limite mais alto do que os outros endpoints de IA — é uma pergunta
  // rápida, à espera de ser usada várias vezes ao longo do dia.
  const rl = await checkRateLimit('rl:quick-ask:' + (user ? user.sub : getClientIp(req)), 20, 3600);
  if (!rl.allowed) {
    res.status(429).json({ error: 'Demasiados pedidos. Tenta novamente daqui a pouco.' });
    return;
  }

  const {
    question, remainingCalories, consumedCalories, goalCalories,
    consumedProtein, consumedCarbs, consumedFat,
    objective, restrictions, preferences, dislikes,
  } = req.body || {};

  const questionText = (question || '').trim();
  if (!questionText) {
    res.status(400).json({ error: 'Pergunta em falta' });
    return;
  }
  if (questionText.length > 300) {
    res.status(400).json({ error: 'Pergunta demasiado longa (máximo 300 caracteres)' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Chave de API não configurada no servidor' });
    return;
  }

  const objectiveLabel = {
    perder: 'perder peso',
    manter: 'manter o peso e a forma física atual',
    ganhar: 'ganhar massa muscular',
  }[objective] || 'o objetivo pessoal definido na app';

  const remaining = Number(remainingCalories);
  const remainingText = Number.isFinite(remaining)
    ? (remaining >= 0 ? `${remaining} kcal ainda disponíveis hoje` : `já ${Math.abs(remaining)} kcal acima da meta de hoje`)
    : 'quantidade de calorias disponíveis desconhecida';

  const restrictionsList = Array.isArray(restrictions) ? restrictions.filter(Boolean) : [];
  const restrictionsText = restrictionsList.length ? restrictionsList.join(', ') : 'nenhuma';
  const preferencesText = (preferences || '').trim() || 'nenhuma em particular';
  const dislikesText = (dislikes || '').trim() || 'nenhum';

  const prompt = `És um assistente de nutrição dentro de uma app de registo de calorias. A pessoa tem uma pergunta rápida sobre o que comer agora, e o teu trabalho é dar uma resposta curta, prática e simpática, em português de Portugal — nunca aconselhamento médico.

Dados do dia da pessoa:
- Objetivo: ${objectiveLabel}
- Meta calórica diária: ${goalCalories || 'desconhecida'} kcal
- Já consumiu hoje: ${consumedCalories ?? 'desconhecido'} kcal (proteína ${consumedProtein ?? '?'}g, hidratos ${consumedCarbs ?? '?'}g, gordura ${consumedFat ?? '?'}g)
- Situação atual: ${remainingText}
- Restrições alimentares: ${restrictionsText}
- Alimentos preferidos: ${preferencesText}
- Alimentos a evitar: ${dislikesText}

Pergunta da pessoa: "${questionText}"

Regras:
- Se a pergunta for sobre o que comer/beber agora, sugere 2 a 3 opções concretas e realistas que caibam nas calorias ainda disponíveis (ou, se já estiver acima da meta, sugere opções muito leves ou de zero/poucas calorias — água, chá, infusões, um caldo — sem fazer a pessoa sentir-se mal por isso).
- Respeita sempre as restrições e alimentos a evitar indicados.
- Se a pergunta não tiver nada a ver com comida/nutrição/o plano da app, responde com simpatia a explicar que só consegues ajudar com perguntas sobre o que comer dentro do plano, e deixa a lista de sugestões vazia.
- Nunca dês conselhos médicos, nunca recomendes deixar de comer ao ponto de prejudicar a saúde, e nunca faças julgamentos sobre a pessoa.
- A resposta ("answer") deve ter no máximo 3 frases curtas.

Responde APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, com exatamente esta estrutura:
{
  "answer": "resposta curta e direta, no máximo 3 frases",
  "suggestions": [
    { "name": "nome do alimento/refeição", "calories": número aproximado, "note": "porque é uma boa escolha agora, até 12 palavras" }
  ]
}
O array "suggestions" deve ter entre 0 e 3 entradas (0 apenas se a pergunta não for sobre comida).`;

  try {
    const model = 'gemini-flash-latest';
    const apiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.6,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      res.status(502).json({ error: 'Erro na API do Gemini', details: errText });
      return;
    }

    const data = await apiResponse.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      res.status(502).json({ error: 'Resposta sem conteúdo de texto' });
      return;
    }

    const clean = text
      .trim()
      .replace(/^```json/i, '')
      .replace(/^```/, '')
      .replace(/```$/, '')
      .trim();

    const parsed = JSON.parse(clean);
    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao obter resposta', details: String(err) });
  }
}
