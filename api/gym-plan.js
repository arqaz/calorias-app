export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  const { objective, activity, equipment, daysPerWeek, sessionMinutes } = req.body || {};
  const days = Number(daysPerWeek);
  if (!days || days < 1 || days > 7) {
    res.status(400).json({ error: 'Número de dias de treino em falta ou inválido' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Chave de API não configurada no servidor' });
    return;
  }

  const objectiveLabel = {
    perder: 'perder peso (mantendo massa muscular)',
    manter: 'manter a forma física atual',
    ganhar: 'ganhar massa muscular',
  }[objective] || 'o objetivo pessoal definido na app';

  const activityLabel = {
    sedentario: 'sedentário, pouco habituado a exercício',
    leve: 'nível de atividade leve',
    moderado: 'nível de atividade moderado',
    ativo: 'nível de atividade elevado',
    muito_ativo: 'nível de atividade muito elevado',
  }[activity] || 'nível de atividade moderado';

  const equipmentList = Array.isArray(equipment) ? equipment.filter(Boolean) : [];
  const equipmentText = equipmentList.length ? equipmentList.join(', ') : 'sem equipamento (apenas peso do corpo)';
  const minutes = Number(sessionMinutes) || 45;

  const prompt = `Cria um plano de treino semanal (7 dias, de segunda a domingo) em português de Portugal, adaptado a estes dados da pessoa:
- Objetivo: ${objectiveLabel}
- Nível de atividade atual: ${activityLabel}
- Material disponível: ${equipmentText}
- Dias de treino por semana: exatamente ${days}
- Duração aproximada de cada sessão: ${minutes} minutos

Regras obrigatórias:
- O array "days" deve ter exatamente 7 entradas (Segunda-feira a Domingo). Exatamente ${days} dessas entradas devem ser dias de treino ("rest": false), distribuídos de forma sensata ao longo da semana (não todos consecutivos, com pelo menos 1 dia de descanso entre grupos musculares grandes quando possível). As restantes são dias de descanso ("rest": true).
- Cada dia de treino deve ter um "focus" (ex: "Corpo inteiro", "Peito e tríceps", "Pernas e core") e uma lista de exercícios adequados ao material disponível indicado — nunca sugerir exercícios que precisem de equipamento que a pessoa não tem.
- Para cada exercício, indica séries, repetições (ou duração, ex: "30 segundos") e tempo de descanso entre séries em segundos. NÃO indiques cargas em quilogramas (a pessoa deve escolher um peso desafiante mas com boa técnica) — usa antes uma nota curta como "peso desafiante, mantendo boa técnica" quando relevante.
- Inclui uma estimativa aproximada e conservadora de calorias queimadas na sessão ("estimated_calories"), deixando claro nas notas gerais que é apenas uma estimativa.
- Em dias de descanso, "exercises" deve ser um array vazio e "estimated_calories" deve ser 0; podes opcionalmente sugerir uma atividade leve opcional no campo "focus" (ex: "Descanso — caminhada leve opcional").
- Não prescrevas nada que exija supervisão médica ou que seja desaconselhável para a fasquia geral da população; inclui sempre aquecimento implícito nas notas gerais.

Responde APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, com exatamente esta estrutura:
{
  "days": [
    {
      "day": "Segunda-feira",
      "rest": false,
      "focus": "nome curto do foco do treino",
      "estimated_calories": número,
      "exercises": [
        { "name": "nome do exercício", "sets": número, "reps": "texto, ex: 12 ou '30 segundos'", "rest_seconds": número, "notes": "dica breve de execução, até 12 palavras" }
      ]
    }
  ],
  "notes": "2 a 3 frases em português com conselhos gerais práticos (aquecimento, progressão gradual, importância da técnica, hidratação)"
}`;

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
    res.status(500).json({ error: 'Falha ao gerar o plano de treino', details: String(err) });
  }
}
