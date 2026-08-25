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
  const rl = await checkRateLimit('rl:meal-plan:' + (user ? user.sub : getClientIp(req)), 10, 3600);
  if (!rl.allowed) {
    res.status(429).json({ error: 'Demasiados pedidos. Tenta novamente daqui a pouco.' });
    return;
  }

  const { objective, goalCalories, restrictions, preferences, dislikes, detailLevel, flexibility } = req.body || {};
  const calories = Number(goalCalories);
  if (!calories || calories <= 0) {
    res.status(400).json({ error: 'Meta calórica em falta ou inválida' });
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

  const restrictionsList = Array.isArray(restrictions) ? restrictions.filter(Boolean) : [];
  const restrictionsText = restrictionsList.length ? restrictionsList.join(', ') : 'nenhuma';
  const preferencesText = (preferences || '').trim() || 'nenhuma em particular';
  const dislikesText = (dislikes || '').trim() || 'nenhum';

  const detailLevelText = detailLevel === 'elaborado'
    ? 'Pode incluir receitas mais elaboradas e variadas, com mais ingredientes e algum tempo de preparação — a pessoa não se importa com isso.'
    : 'Prefere receitas simples e rápidas de preparar, com poucos ingredientes.';
  const flexibilityText = flexibility === 'flexivel'
    ? 'A pessoa prefere ter liberdade para escolher — em cada refeição, sugere a par da refeição principal 1 a 2 alternativas equivalentes em calorias que possa escolher em vez dela, e refere isso nas notas.'
    : 'A pessoa prefere um plano definido ao pormenor, dia a dia, sem alternativas — cada refeição deve ser uma sugestão única e concreta.';

  const prompt = `Cria um plano de refeições semanal (7 dias, de segunda a domingo) em português de Portugal, adaptado a estes dados da pessoa:
- Objetivo: ${objectiveLabel}
- Meta calórica diária: ${calories} kcal
- Restrições alimentares: ${restrictionsText}
- Alimentos preferidos: ${preferencesText}
- Alimentos a evitar: ${dislikesText}
- Nível de detalhe das receitas: ${detailLevelText}
- Estilo do plano: ${flexibilityText}

Regras:
- Para cada dia, sugere exatamente 4 refeições, nesta ordem: "Pequeno-almoço", "Almoço", "Lanche", "Jantar".
- As refeições devem ser realistas, fáceis de preparar em casa, variadas ao longo da semana (não repitas a mesma refeição em dois dias), e respeitar rigorosamente as restrições alimentares indicadas.
- A soma das calorias das 4 refeições de cada dia deve aproximar-se da meta calórica diária (margem de ±10%).
- Sugere também metas diárias de macronutrientes (proteína, hidratos, gordura em gramas) coerentes com o objetivo e a meta calórica.
- Não incluas nenhum conselho médico, apenas sugestões de refeições.

Responde APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, com exatamente esta estrutura:
{
  "macro_targets": { "protein_g": número, "carbs_g": número, "fat_g": número },
  "days": [
    {
      "day": "Segunda-feira",
      "meals": [
        { "type": "Pequeno-almoço", "name": "nome curto", "description": "descrição breve, até 15 palavras", "calories": número, "protein_g": número, "carbs_g": número, "fat_g": número }
      ]
    }
  ],
  "notes": "1 a 2 frases em português com um conselho geral prático sobre como seguir o plano"
}
O array "days" deve ter exatamente 7 entradas (Segunda-feira a Domingo), cada uma com exatamente 4 refeições.`;

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
    res.status(500).json({ error: 'Falha ao gerar o plano de refeições', details: String(err) });
  }
}
