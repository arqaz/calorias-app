import { requireEntitledUser, getClientIp } from '../lib/auth.js';
import { checkRateLimit } from '../lib/kv.js';
import { callGeminiJSON } from '../lib/gemini.js';

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
  // Limite mais alto do que os endpoints de planos — pode usar-se uma vez
  // por sessão de exercício, várias vezes ao dia.
  const rl = await checkRateLimit('rl:exercise-estimate:' + (user ? user.sub : getClientIp(req)), 20, 3600);
  if (!rl.allowed) {
    res.status(429).json({ error: 'Demasiados pedidos. Tenta novamente daqui a pouco.' });
    return;
  }

  const { description, weight, sex, activity } = req.body || {};
  const descriptionText = (description || '').trim();
  if (!descriptionText) {
    res.status(400).json({ error: 'Descrição em falta' });
    return;
  }
  if (descriptionText.length > 200) {
    res.status(400).json({ error: 'Descrição demasiado longa (máximo 200 caracteres)' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Chave de API não configurada no servidor' });
    return;
  }

  const weightNum = Number(weight);
  const weightText = weightNum > 0 ? `${weightNum} kg` : 'desconhecido (assume cerca de 70 kg)';
  const sexLabel = { m: 'masculino', f: 'feminino' }[sex] || 'desconhecido';
  const activityLabel = {
    sedentario: 'sedentário, pouco habituado a exercício',
    leve: 'nível de atividade leve',
    moderado: 'nível de atividade moderado',
    ativo: 'nível de atividade elevado',
    muito_ativo: 'nível de atividade muito elevado',
  }[activity] || 'nível de atividade desconhecido';

  const prompt = `Estima as calorias queimadas na seguinte descrição de exercício, feita por uma pessoa numa app de registo de calorias. Sê realista e conservador — é apenas uma estimativa aproximada, não um cálculo científico.

Descrição da pessoa: "${descriptionText}"
Peso da pessoa: ${weightText}
Sexo: ${sexLabel}
Nível de atividade habitual: ${activityLabel}

Regras:
- Se a descrição não indicar duração, assume uma duração típica e razoável para essa atividade e refere isso na nota.
- Se a descrição não for de todo um exercício físico (ex: texto aleatório), interpreta com bom senso a atividade mais próxima ou usa calorias 0 e explica isso na nota.
- "name" deve ser um nome curto e limpo para o exercício (ex: "Corrida", "Musculação — pernas"), não a frase toda da pessoa.
- Nunca dês conselhos médicos.

Responde APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, com exatamente esta estrutura:
{
  "name": "nome curto do exercício",
  "calories": número aproximado de calorias queimadas,
  "note": "breve explicação da estimativa (duração assumida, intensidade, etc.), até 15 palavras"
}`;

  try {
    const parsed = await callGeminiJSON({ apiKey, parts: [{ text: prompt }], temperature: 0.4 });
    res.status(200).json(parsed);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Falha ao calcular a estimativa' });
  }
}
