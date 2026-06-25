const BASE = 'https://ccm.artesp.sp.gov.br/metroferroviario/api';

export type StatusType = 'normal' | 'lento' | 'atencao' | 'parado';

export interface LineStatus {
  num:          string;
  name:         string;
  status:       StatusType;
  note:         string;
  atualizadoHa?: string;
}

let _cachedRaw: unknown = null;
let _cachedAt  = 0;

export function getCachedRaw(): { data: unknown; cachedAt: number } | null {
  if (!_cachedRaw) return null;
  return { data: _cachedRaw, cachedAt: _cachedAt };
}

const LINE_NAMES: Record<string, string> = {
  '1':  'Azul',
  '2':  'Verde',
  '3':  'Vermelha',
  '4':  'Amarela',
  '5':  'Lilás',
  '7':  'Rubi',
  '8':  'Diamante',
  '9':  'Esmeralda',
  '10': 'Turquesa',
  '11': 'Coral',
  '12': 'Safira',
  '13': 'Jade',
  '15': 'Prata',
};

function mapSituacao(situacao: string, classificacao: string): StatusType {
  if (classificacao === 'problema') return 'parado';
  if (classificacao === 'ignorar')  return 'normal';

  switch (situacao) {
    case 'Operação Normal':
    case 'Operação Encerrada':
      return 'normal';
    case 'Velocidade Reduzida':
    case 'Maiores Intervalos':
      return 'lento';
    case 'Operação Parcial':
    case 'Circulação de Trens':
    case 'Atividade Programada':
      return 'atencao';
    case 'Dados Indisponíveis':
      return 'parado';
    default:
      return 'normal';
  }
}

interface ApiStatus {
  empresas: Array<{
    linhas: Array<{
      codigo: string;
      status: {
        situacao:      string;
        classificacao: string;
        descricao:     string;
        atualizado_ha: string;
      };
    }>;
  }>;
}

export class RateLimitError extends Error {
  constructor() { super('rate limited (429)'); this.name = 'RateLimitError'; }
}

export async function fetchStatus(): Promise<LineStatus[]> {
  const res = await fetch(`${BASE}/status/`, {
    headers: { Accept: 'application/json', Authorization: `Api-Key ${process.env.CCM_API_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429) throw new RateLimitError();
  if (!res.ok) throw new Error(`/status/ HTTP ${res.status}`);

  const data: ApiStatus = await res.json() as ApiStatus;

  _cachedRaw = data;
  _cachedAt  = Date.now();

  const lines: LineStatus[] = [];

  for (const empresa of data.empresas) {
    for (const apiLine of empresa.linhas) {
      const name = LINE_NAMES[apiLine.codigo];
      if (!name) continue;

      lines.push({
        num:          apiLine.codigo,
        name,
        status:       mapSituacao(apiLine.status.situacao, apiLine.status.classificacao),
        note:         apiLine.status.descricao || apiLine.status.situacao,
        atualizadoHa: apiLine.status.atualizado_ha,
      });
    }
  }

  return lines.sort((a, b) => parseInt(a.num) - parseInt(b.num));
}
