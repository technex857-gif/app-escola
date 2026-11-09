/**
 * GABARITA — leitor de cartão-resposta (JavaScript puro, sem dependências).
 *
 * Entrada: imagem RGBA ({ width, height, data }) já reduzida/ampliada para lado maior ≈ 1600 px.
 * Método:
 *  1. Localiza as duas tabelas de respostas pelo contorno (limiar relativo ao brilho do papel).
 *     Se só uma for achada, a outra é projetada (o papel é plano). Se nenhuma, o app pede
 *     que o usuário toque nos 4 cantos da tabela da esquerda (opts.cantos).
 *  2. Corrige a perspectiva (homografia) e mede, em cada bolha, a fração de pixels
 *     azuis (caneta azul) ou escuros (caneta preta). Letras impressas e faixas cinzas
 *     não contam: são neutras e finas.
 *  3. Classifica cada questão: uma marcação (letra), nenhuma (null) ou várias ('!').
 *     Questões duvidosas são sinalizadas em `revisar` para o professor conferir.
 *
 * Limitação: só existe o modelo "Goiás 40 questões" (duas tabelas de 20 linhas).
 */
(function (raiz) {
    'use strict';

    const S = 3;                 // pixels por pt no espaço normalizado
    const FATOR_ESCURO = 0.46;   // pixel "escuro" (caneta preta/grafite): cinza abaixo de FATOR·brilho do papel
    const LIMIAR_MARCA = 0.30;   // fração de preenchimento que conta como marcada
    const REVISAR_DE = 0.08;     // preenchimento parcial nessa faixa = duvidoso
    const REVISAR_ATE = 0.45;
    const LADO_MAIOR = 1600;
    const LIMIAR_ANEIS = 0.07;       // pontuação mínima do refinamento por anéis (alinhado ≈ 0,09–0,36)
    const LIMIAR_ALINHAMENTO = 0.15; // contraste mínimo das faixas das linhas (ver contrasteListras)

    // Geometria em pt, medida no PDF do cartão em branco
    const MODELO_GOIAS_40 = {
        id: 'goias-40',
        nome: 'Bloco de avaliação – 40 questões',
        questoes: 40,
        opcoes: ['A', 'B', 'C', 'D', 'E'],
        tabelas: [{ x0: 114.0, x1: 292.6 }, { x0: 314.8, x1: 493.5 }],
        y0: 314.9,
        y1: 723.6,
        xBolhas: [[155.2, 170.9, 186.7, 202.4, 218.2], [355.4, 371.1, 386.9, 402.6, 418.4]],
        yPrimeira: 341.6,
        passo: 19.58,
        linhas: 20,
        raio: 6.0
    };

    // ------------------------------------------------------------------
    // Geometria básica
    // ------------------------------------------------------------------
    function ordenar(q) { // → [topo-esq, topo-dir, base-dir, base-esq]
        let tl = 0, tr = 0, br = 0, bl = 0;
        q.forEach((p, i) => {
            if (p[0] + p[1] < q[tl][0] + q[tl][1]) tl = i;
            if (p[0] + p[1] > q[br][0] + q[br][1]) br = i;
            if (p[1] - p[0] < q[tr][1] - q[tr][0]) tr = i;
            if (p[1] - p[0] > q[bl][1] - q[bl][0]) bl = i;
        });
        return [q[tl], q[tr], q[br], q[bl]];
    }

    function area(poly) {
        let s = 0;
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            s += a[0] * b[1] - b[0] * a[1];
        }
        return Math.abs(s) / 2;
    }

    function perimetro(poly) {
        let s = 0;
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            s += Math.hypot(a[0] - b[0], a[1] - b[1]);
        }
        return s;
    }

    function casco(pts) { // cadeia monotônica de Andrew
        const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        if (p.length < 3) return p;
        const cruz = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const baixo = [];
        for (const pt of p) {
            while (baixo.length >= 2 && cruz(baixo[baixo.length - 2], baixo[baixo.length - 1], pt) <= 0) baixo.pop();
            baixo.push(pt);
        }
        const cima = [];
        for (let i = p.length - 1; i >= 0; i--) {
            const pt = p[i];
            while (cima.length >= 2 && cruz(cima[cima.length - 2], cima[cima.length - 1], pt) <= 0) cima.pop();
            cima.push(pt);
        }
        baixo.pop(); cima.pop();
        return baixo.concat(cima);
    }

    // Quadrilátero de maior área com vértices no casco convexo (O(n^3) pela diagonal).
    // Cai nos cantos reais mesmo quando o contorno tem pequenas saliências.
    function quad4(cascoPts) {
        let h = cascoPts;
        if (h.length > 90) { const passo = h.length / 90; h = Array.from({ length: 90 }, (_, i) => cascoPts[Math.floor(i * passo)]); }
        const n = h.length;
        if (n < 4) return null;
        const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
        let melhor = 0, q = null;
        for (let i = 0; i < n; i++) {
            for (let k = i + 2; k < n; k++) {
                let bj = 0, ij = -1, bl = 0, il = -1;
                for (let j = i + 1; j < k; j++) { const a = tri(h[i], h[j], h[k]); if (a > bj) { bj = a; ij = j; } }
                for (let l = k + 1; l < n; l++) { const a = tri(h[k], h[l], h[i]); if (a > bl) { bl = a; il = l; } }
                if (ij >= 0 && il >= 0 && bj + bl > melhor) { melhor = bj + bl; q = [h[i], h[ij], h[k], h[il]]; }
            }
        }
        return q;
    }

    // Homografia que leva src[i] em dst[i] (4 pontos). Retorna 9 números (h22 = 1)
    function homografia(src, dst) {
        const A = [];
        for (let i = 0; i < 4; i++) {
            const [x, y] = src[i], [u, v] = dst[i];
            A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
            A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
        }
        for (let c = 0; c < 8; c++) {
            let p = c;
            for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
            if (Math.abs(A[p][c]) < 1e-12) return null;
            [A[c], A[p]] = [A[p], A[c]];
            for (let r = 0; r < 8; r++) {
                if (r === c) continue;
                const f = A[r][c] / A[c][c];
                for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
            }
        }
        const h = A.map((linha, i) => linha[8] / linha[i]);
        return [...h, 1];
    }

    function aplicar(H, x, y) {
        const w = H[6] * x + H[7] * y + H[8];
        return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
    }

    // ------------------------------------------------------------------
    // Processamento de imagem
    // ------------------------------------------------------------------
    function cinza(img) {
        const { data, width: w, height: h } = img;
        const g = new Uint8Array(w * h);
        for (let i = 0, j = 0; i < g.length; i++, j += 4) {
            g[i] = (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2] + 0.5) | 0;
        }
        return g;
    }

    function metade(g, w, h) {
        const w2 = w >> 1, h2 = h >> 1;
        const o = new Uint8Array(w2 * h2);
        for (let y = 0; y < h2; y++) {
            for (let x = 0; x < w2; x++) {
                const i = 2 * y * w + 2 * x;
                o[y * w2 + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1] + 2) >> 2;
            }
        }
        return { g: o, w: w2, h: h2 };
    }

    function suavizar(g, w, h) { // [1 4 6 4 1]/16 separável
        const k = [1, 4, 6, 4, 1];
        const tmp = new Float32Array(w * h);
        const out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let s = 0;
                for (let d = -2; d <= 2; d++) s += k[d + 2] * g[y * w + Math.min(w - 1, Math.max(0, x + d))];
                tmp[y * w + x] = s;
            }
        }
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let s = 0;
                for (let d = -2; d <= 2; d++) s += k[d + 2] * tmp[Math.min(h - 1, Math.max(0, y + d)) * w + x];
                out[y * w + x] = (s / 256 + 0.5) | 0;
            }
        }
        return out;
    }

    function percentil(g, w, h, p) {
        const hist = new Uint32Array(256);
        let n = 0;
        for (let y = Math.floor(h * 0.15); y < Math.floor(h * 0.9); y++) {
            for (let x = Math.floor(w * 0.05); x < Math.floor(w * 0.95); x++) { hist[g[y * w + x]]++; n++; }
        }
        let acc = 0;
        for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= p * n) return v; }
        return 255;
    }

    // Janela quadrada (2r+1) por somas acumuladas; modo 'dilatar' ou 'erodir'
    function janela(m, w, h, r, modo) {
        const tmp = new Uint8Array(w * h);
        const out = new Uint8Array(w * h);
        const pre = new Int32Array(Math.max(w, h) + 1);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + m[y * w + x];
            for (let x = 0; x < w; x++) {
                const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
                const s = pre[b + 1] - pre[a];
                tmp[y * w + x] = modo === 'dilatar' ? (s > 0 ? 1 : 0) : (s === b - a + 1 ? 1 : 0);
            }
        }
        for (let x = 0; x < w; x++) {
            for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
            for (let y = 0; y < h; y++) {
                const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
                const s = pre[b + 1] - pre[a];
                out[y * w + x] = modo === 'dilatar' ? (s > 0 ? 1 : 0) : (s === b - a + 1 ? 1 : 0);
            }
        }
        return out;
    }
    const fechar = (m, w, h, r) => janela(janela(m, w, h, r, 'dilatar'), w, h, r, 'erodir');

    // Componentes conexos (8 vizinhos) com caixa e cascos só dos grandes
    function componentes(m, w, h, minCaixa) {
        const visto = new Uint8Array(w * h);
        const fila = new Int32Array(w * h);
        const comps = [];
        for (let s = 0; s < w * h; s++) {
            if (!m[s] || visto[s]) continue;
            let ini = 0, fim = 0;
            fila[fim++] = s; visto[s] = 1;
            let x0 = w, x1 = 0, y0 = h, y1 = 0;
            while (ini < fim) {
                const i = fila[ini++];
                const x = i % w, y = (i / w) | 0;
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
                for (let dy = -1; dy <= 1; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= h) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= w) continue;
                        const j = yy * w + xx;
                        if (m[j] && !visto[j]) { visto[j] = 1; fila[fim++] = j; }
                    }
                }
            }
            const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
            if (bw * bh < minCaixa) continue;
            const mn = new Int32Array(h).fill(w), mx = new Int32Array(h).fill(-1);
            for (let k = 0; k < fim; k++) {
                const i = fila[k], x = i % w, y = (i / w) | 0;
                if (x < mn[y]) mn[y] = x;
                if (x > mx[y]) mx[y] = x;
            }
            const pts = [];
            for (let y = y0; y <= y1; y++) if (mx[y] >= 0) { pts.push([mn[y], y]); pts.push([mx[y], y]); }
            comps.push({ x: x0, y: y0, bw, bh, casco: casco(pts) });
        }
        return comps;
    }

    // ------------------------------------------------------------------
    // Localização das tabelas
    // ------------------------------------------------------------------
    function razaoQuad(q) {
        const larg = (Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) + Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1])) / 2;
        const alt = (Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])) / 2;
        return { larg, alt, r: larg / alt };
    }

    function projetarParceira(q, modelo, sinal) {
        const W = modelo.tabelas[0].x1 - modelo.tabelas[0].x0;
        const Hh = modelo.y1 - modelo.y0;
        const dx = modelo.tabelas[1].x0 - modelo.tabelas[0].x0;
        const H = homografia([[0, 0], [W, 0], [W, Hh], [0, Hh]], q);
        if (!H) return null;
        const loc = [[sinal * dx, 0], [sinal * dx + W, 0], [sinal * dx + W, Hh], [sinal * dx, Hh]];
        return loc.map(([x, y]) => aplicar(H, x, y));
    }

    // Aumenta um quadrilátero a partir do centro (região de busca generosa)
    function expandir(q, fator, margem) {
        const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
        return q.map(([x, y]) => {
            const dx = (x - cx) * fator, dy = (y - cy) * fator, n = Math.hypot(dx, dy) || 1;
            return [cx + dx + (dx / n) * margem, cy + dy + (dy / n) * margem];
        });
    }

    function dentroConvexo(poly, x, y) {
        let sinal = 0;
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
            if (c !== 0) { if (sinal === 0) sinal = c > 0 ? 1 : -1; else if ((c > 0 ? 1 : -1) !== sinal) return false; }
        }
        return true;
    }

    // roi (opcional): quadriláteros aproximados (coordenadas da imagem inteira). Fora deles a imagem
    // é tratada como papel branco, o que impede o fundo de se fundir com as tabelas.
    function acharTabelas(img, modelo, roi) {
        const gCheio = cinza(img);
        const m2 = metade(gCheio, img.width, img.height);
        const w = m2.w, h = m2.h;
        const g = suavizar(m2.g, w, h);
        const P = percentil(g, w, h, 0.80);
        if (roi) {
            const regioes = roi.map(q => expandir(q, 1.3, 60).map(p => [p[0] / 2, p[1] / 2]));
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    if (!regioes.some(r => dentroConvexo(r, x, y))) g[y * w + x] = 255;
                }
            }
        }
        const cand = [];

        for (const f of [0.62, 0.65, 0.68, 0.71, 0.74, 0.77, 0.80, 0.83, 0.86, 0.89]) {
            const lim = f * P;
            const bin = new Uint8Array(w * h);
            for (let i = 0; i < bin.length; i++) bin[i] = g[i] < lim ? 1 : 0;
            const fechado = fechar(bin, w, h, 2);
            for (const c of componentes(fechado, w, h, 0.04 * w * h)) {
                if (c.x <= 1 || c.y <= 1 || c.x + c.bw >= w - 1 || c.y + c.bh >= h - 1 || c.bw > 0.6 * w) continue;
                if (area(c.casco) < 0.04 * w * h) continue;
                const q4 = quad4(c.casco);
                if (!q4) continue;
                const qa = area(q4);
                if (area(c.casco) / qa > 1.10) continue;
                const qq = ordenar(q4);
                const { r } = razaoQuad(qq);
                if (!(r > 0.36 && r < 0.58)) continue;
                cand.push({ a: qa, q: qq });
            }
        }

        const escala = (qs) => qs.map(q => q.map(p => [p[0] * 2, p[1] * 2]));
        // Hipóteses de alinhamento (cantos externos, px da imagem) para o refinamento por anéis:
        // cada candidato isolado serve como tabela esquerda ou direita (a outra é projetada).
        const unicos = [];
        for (const c of cand.slice().sort((a, b) => b.a - a.a)) {
            const cx = c.q.reduce((s, p) => s + p[0], 0) / 4, cy = c.q.reduce((s, p) => s + p[1], 0) / 4;
            if (!unicos.some(u => Math.hypot(u.cx - cx, u.cy - cy) < 8)) unicos.push({ cx, cy, q: c.q });
        }
        const hips = [];
        for (const u of unicos) {
            // o contorno pode ter cantos errados (rótulos, sombra): testa também o retângulo envolvente
            const xs = u.q.map(p => p[0]), ys = u.q.map(p => p[1]);
            const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
            for (const q of [u.q, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]) {
                const d = projetarParceira(q, modelo, +1), e = projetarParceira(q, modelo, -1);
                if (d) hips.push(externos(escala([q, d])));
                if (e) hips.push(externos(escala([e, q])));
            }
        }
        let melhor = null;
        for (const A of cand) {
            for (const B of cand) {
                const ca = [A.q.reduce((s, p) => s + p[0], 0) / 4, A.q.reduce((s, p) => s + p[1], 0) / 4];
                const cb = [B.q.reduce((s, p) => s + p[0], 0) / 4, B.q.reduce((s, p) => s + p[1], 0) / 4];
                if (cb[0] <= ca[0]) continue;
                const ra = razaoQuad(A.q), rb = razaoQuad(B.q);
                const larg = (ra.larg + rb.larg) / 2, alt = (ra.alt + rb.alt) / 2;
                if (!(A.a / B.a > 0.7 && A.a / B.a < 1.43)) continue;
                if (Math.abs(ca[1] - cb[1]) > 0.15 * alt) continue;
                const d = (cb[0] - ca[0]) / larg;
                if (!(d > 0.95 && d < 1.45)) continue;
                const sc = A.a + B.a;
                if (!melhor || sc > melhor.sc) melhor = { sc, q: [A.q, B.q] };
            }
        }
        if (melhor) hips.unshift(externos(escala(melhor.q)));
        if (melhor) return { quads: escala(melhor.q), origem: 'automatica', P, hips };

        if (!cand.length) return null;
        const unico = cand.reduce((a, b) => (Math.abs(razaoQuad(b.q).r - 0.45) < Math.abs(razaoQuad(a.q).r - 0.45) ? b : a));
        const dir = projetarParceira(unico.q, modelo, +1);
        const esq = projetarParceira(unico.q, modelo, -1);
        const dentro = (p) => p && p.every(([x, y]) => x >= 0 && x <= w && y >= 0 && y <= h);
        let par;
        if (dentro(dir) && !dentro(esq)) par = [unico.q, dir];
        else if (dentro(esq) && !dentro(dir)) par = [esq, unico.q];
        else par = unico.q[0][0] < w / 2 ? [unico.q, dir] : [esq, unico.q];
        if (!par[0] || !par[1]) return null;
        return { quads: escala(par), origem: 'projetada', P, hips };
    }


    // ------------------------------------------------------------------
    // Refinamento por anéis: ajusta o alinhamento maximizando o contraste dos círculos
    // impressos das 200 bolhas (anel escuro em r=6 pt, papel claro em r≈3,7 e r≈8).
    // É o que torna a leitura independente do contorno das tabelas (que pode ser
    // contaminado por rótulos "Biologia/Física/Química", sombras e iluminação).
    // ------------------------------------------------------------------
    const ANGULOS = 12;
    const COS = Array.from({ length: ANGULOS }, (_, i) => Math.cos(2 * Math.PI * i / ANGULOS));
    const SEN = Array.from({ length: ANGULOS }, (_, i) => Math.sin(2 * Math.PI * i / ANGULOS));

    function cantosModelo(modelo) {
        const x0 = modelo.tabelas[0].x0, x1 = modelo.tabelas[1].x1;
        return [[x0, modelo.y0], [x1, modelo.y0], [x1, modelo.y1], [x0, modelo.y1]];
    }

    function tabelasDe(H, modelo) { // quads das duas tabelas a partir da homografia modelo(pt)→imagem
        return modelo.tabelas.map(t => [[t.x0, modelo.y0], [t.x1, modelo.y0], [t.x1, modelo.y1], [t.x0, modelo.y1]]
            .map(([x, y]) => aplicar(H, x, y)));
    }

    function cinzaEm(img, x, y) {
        const { data, width: w, height: h } = img;
        const xi = Math.round(x), yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
        const o = (yi * w + xi) * 4;
        return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    }

    // Média, sobre as bolhas, de (papel − anel)/P. ~0,2 alinhado; ~0 desalinhado.
    function pontuarAnéis(img, H, modelo, P, so) {
        let soma = 0, n = 0;
        for (let t = 0; t < 2; t++) {
            if (so !== undefined && so !== t) continue;
            for (let i = 0; i < modelo.linhas; i++) {
                const cy = modelo.yPrimeira + i * modelo.passo;
                for (let k = 0; k < modelo.opcoes.length; k++) {
                    const cx = modelo.xBolhas[t][k];
                    for (let a = 0; a < ANGULOS; a++) {
                        const p0 = aplicar(H, cx + 6.0 * COS[a], cy + 6.0 * SEN[a]);
                        const p1 = aplicar(H, cx + 8.0 * COS[a], cy + 8.0 * SEN[a]);
                        const p2 = aplicar(H, cx + 3.7 * COS[a], cy + 3.7 * SEN[a]);
                        const g0 = cinzaEm(img, p0[0], p0[1]), g1 = cinzaEm(img, p1[0], p1[1]), g2 = cinzaEm(img, p2[0], p2[1]);
                        if (g0 === null || g1 === null || g2 === null) { n++; continue; }
                        // bolha preenchida: anel e miolo escuros → só o lado de fora conta, com meio peso
                        soma += (g2 > g0 ? (g1 + g2) / 2 : g1 * 0.8 + g0 * 0.2) - g0;
                        n++;
                    }
                }
            }
        }
        return soma / n / P;
    }

    // Descida por coordenadas com passos decrescentes. Movimentos: cada canto, cada lado
    // (dois cantos) e o quadrilátero inteiro — mover só um canto por vez fica preso em
    // máximos locais, pois as bolhas se repetem em colunas e linhas.
    const GRUPOS = [[0], [1], [2], [3], [0, 3], [1, 2], [0, 1], [3, 2], [0, 1, 2, 3]];
    function descer(pt, pontuar, passos) {
        let melhor = pontuar(pt);
        for (const passo of passos) {
            let mexeu = true, rodadas = 0;
            while (mexeu && rodadas++ < 8) {
                mexeu = false;
                for (const g of GRUPOS) {
                    for (const [dx, dy] of [[passo, 0], [-passo, 0], [0, passo], [0, -passo]]) {
                        const c = pt.map(p => p.slice());
                        for (const i of g) { c[i][0] += dx; c[i][1] += dy; }
                        const sc = pontuar(c);
                        if (sc > melhor + 1e-4) { melhor = sc; for (const i of g) pt[i] = c[i]; mexeu = true; }
                    }
                }
            }
        }
        return melhor;
    }

    // Busca local nos 4 cantos externos.
    function refinarAneis(img, cantos, modelo, P) {
        const src = cantosModelo(modelo);
        const pt = cantos.map(p => [p[0], p[1]]);
        const pontuar = (c) => { const H = homografia(src, c); return H ? pontuarAnéis(img, H, modelo, P) : -1; };
        const melhor = descer(pt, pontuar, [24, 12, 6, 3, 1.5, 0.75]);
        const H = homografia(src, pt);
        return H ? { pontos: pt, pontuacao: melhor, H, quads: tabelasDe(H, modelo) } : null;
    }

    // Segunda etapa: o papel nunca é perfeitamente plano (curvatura, dobras); ajusta cada
    // tabela sozinha, com passos pequenos, partindo do alinhamento global.
    function refinarTabela(img, quad, modelo, t, P) {
        const tb = modelo.tabelas[t];
        const src = [[tb.x0, modelo.y0], [tb.x1, modelo.y0], [tb.x1, modelo.y1], [tb.x0, modelo.y1]];
        const pt = quad.map(p => [p[0], p[1]]);
        const pontuar = (c) => { const H = homografia(src, c); return H ? pontuarAnéis(img, H, modelo, P, t) : -1; };
        // varredura exaustiva de translação (as bolhas se repetem; a descida sozinha trava)
        let bx = 0, by = 0, bs = pontuar(pt);
        for (let dy = -16; dy <= 16; dy += 2) {
            for (let dx = -16; dx <= 16; dx += 2) {
                const sc = pontuar(pt.map(p => [p[0] + dx, p[1] + dy]));
                if (sc > bs) { bs = sc; bx = dx; by = dy; }
            }
        }
        pt.forEach(p => { p[0] += bx; p[1] += by; });
        const melhor = descer(pt, pontuar, [6, 3, 1.5, 0.75]);
        return { quad: pt, pontuacao: melhor };
    }

    // Cantos externos (esq-topo, dir-topo, dir-base, esq-base) a partir do par de quads
    const externos = (q) => [q[0][0], q[1][1], q[1][2], q[0][3]];

    // ------------------------------------------------------------------
    // Medição das bolhas
    // ------------------------------------------------------------------
    function retanguloNormalizado(modelo) {
        const W = Math.floor((modelo.tabelas[0].x1 - modelo.tabelas[0].x0) * S);
        const Hh = Math.floor((modelo.y1 - modelo.y0) * S);
        return { W, H: Hh, pontos: [[0, 0], [W, 0], [W, Hh], [0, Hh]] };
    }

    // Centro da bolha no espaço normalizado da tabela t (pixels)
    function centroBolha(modelo, t, linha, opcao) {
        return {
            x: (modelo.xBolhas[t][opcao] - modelo.tabelas[t].x0) * S,
            y: (modelo.yPrimeira + linha * modelo.passo - modelo.y0) * S,
            r: modelo.raio * S
        };
    }

    function amostrar(img, x, y, saida) { // bilinear
        const { data, width: w, height: h } = img;
        if (x < 0 || y < 0 || x > w - 1 || y > h - 1) { saida[0] = saida[1] = saida[2] = 255; return; }
        const x0 = x | 0, y0 = y | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
        const fx = x - x0, fy = y - y0;
        for (let c = 0; c < 3; c++) {
            const a = data[(y0 * w + x0) * 4 + c], b = data[(y0 * w + x1) * 4 + c];
            const d = data[(y1 * w + x0) * 4 + c], e = data[(y1 * w + x1) * 4 + c];
            saida[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
        }
    }

    function ehAzul(r, g, b) { // convenção OpenCV: H 0–180, S/V 0–255
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx < 30) return false;
        const delta = mx - mn;
        if (delta === 0) return false;
        const s = 255 * delta / mx;
        if (s < 70) return false;
        let hue;
        if (mx === r) hue = 60 * (g - b) / delta;
        else if (mx === g) hue = 120 + 60 * (b - r) / delta;
        else hue = 240 + 60 * (r - g) / delta;
        if (hue < 0) hue += 360;
        hue /= 2;
        return hue >= 95 && hue <= 135;
    }

    function medirTabela(img, quad, modelo, t, P) {
        const { pontos } = retanguloNormalizado(modelo);
        const H = homografia(pontos, quad);
        if (!H) return null;
        const resultado = [];
        const rgb = [0, 0, 0];
        const raio = Math.floor(modelo.raio * S * 0.75);
        for (let i = 0; i < modelo.linhas; i++) {
            const linha = [];
            for (let k = 0; k < modelo.opcoes.length; k++) {
                const c = centroBolha(modelo, t, i, k);
                let n = 0, azuis = 0, escuros = 0;
                for (let dy = -raio; dy <= raio; dy++) {
                    for (let dx = -raio; dx <= raio; dx++) {
                        if (dx * dx + dy * dy > raio * raio) continue;
                        const [px, py] = aplicar(H, Math.round(c.x) + dx, Math.round(c.y) + dy);
                        amostrar(img, px, py, rgb);
                        n++;
                        if (ehAzul(rgb[0], rgb[1], rgb[2])) azuis++;
                        const gray = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
                        if (gray < FATOR_ESCURO * P) escuros++;
                    }
                }
                linha.push(Math.max(azuis, escuros) / n);
            }
            resultado.push(linha);
        }
        return resultado;
    }

    // Verifica o alinhamento pelas faixas alternadas (linhas claras e cinzas) da coluna "Professor",
    // que fica vazia. Retorna (brilho das linhas claras - brilho das cinzas) / brilho do papel:
    // ~0,3 quando alinhado; perto de 0 ou negativo quando deslocado meia linha ou uma linha.
    function contrasteListras(img, quad, modelo, t, P) {
        const { pontos } = retanguloNormalizado(modelo);
        const H = homografia(pontos, quad);
        if (!H) return 0;
        const larg = modelo.tabelas[t].x1 - modelo.tabelas[t].x0;
        const xc = (larg * 0.85) * S;
        const meiaAlt = Math.floor(modelo.passo * S * 0.25);
        const rgb = [0, 0, 0];
        const claras = [], cinzas = [];
        for (let i = 0; i < modelo.linhas; i++) {
            const yc = (modelo.yPrimeira + i * modelo.passo - modelo.y0) * S;
            let soma = 0, n = 0;
            for (let dy = -meiaAlt; dy <= meiaAlt; dy += 2) {
                for (let dx = -14; dx <= 14; dx += 2) {
                    const [px, py] = aplicar(H, xc + dx, yc + dy);
                    amostrar(img, px, py, rgb);
                    soma += 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]; n++;
                }
            }
            (i % 2 === 0 ? claras : cinzas).push(soma / n);
        }
        const mediana = (a) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
        return (mediana(claras) - mediana(cinzas)) / P;
    }

    function classificar(fracoes, modelo) {
        const respostas = [], revisar = [];
        fracoes.forEach((fr) => {
            const marcadas = [];
            fr.forEach((f, k) => { if (f > LIMIAR_MARCA) marcadas.push(modelo.opcoes[k]); });
            respostas.push(marcadas.length === 1 ? marcadas[0] : (marcadas.length === 0 ? null : '!'));
            // Em branco "limpo" (nenhuma bolha com tinta) não precisa de revisão; dupla marcação e tinta parcial, sim
            revisar.push(marcadas.length > 1 || fr.some(f => f >= REVISAR_DE && f <= REVISAR_ATE));
        });
        return { respostas, revisar };
    }

    /**
     * Lê o cartão. opts.cantos = 4 pontos [x,y] da tabela da ESQUERDA (em qualquer ordem),
     * em coordenadas da imagem informada; dispensa a detecção automática.
     */
    // Testa as hipóteses de alinhamento, refina as mais promissoras e devolve a melhor.
    function melhorAlinhamento(img, hips, modelo, P) {
        const src = cantosModelo(modelo);
        const pont = hips.map(c => { const H = homografia(src, c); return { c, s: H ? pontuarAnéis(img, H, modelo, P) : -1 }; })
            .sort((a, b) => b.s - a.s);
        let melhor = null;
        for (const h of pont.slice(0, 8)) {
            const r = refinarAneis(img, h.c, modelo, P);
            if (r && (!melhor || r.pontuacao > melhor.pontuacao)) melhor = r;
        }
        return melhor;
    }

    function lerCartao(img, modelo = MODELO_GOIAS_40, opts = {}) {
        let achado;
        if (opts.cantos) {
            if (!Array.isArray(opts.cantos) || opts.cantos.length !== 4) return { ok: false, motivo: 'Marque os 4 cantos da tabela.' };
            const esq = ordenar(opts.cantos);
            const dir = projetarParceira(esq, modelo, +1);
            if (!dir) return { ok: false, motivo: 'Os cantos marcados não formam uma tabela válida.' };
            // Toques de dedo são imprecisos (a leitura tolera só ~3 px): servem de região de busca
            achado = acharTabelas(img, modelo, [esq, dir]);
            if (achado) {
                achado.origem = 'manual-refinada';
                achado.hips.push(externos([esq, dir]));
            } else {
                const g = cinza(img);
                achado = { quads: [esq, dir], origem: 'manual', P: percentil(g, img.width, img.height, 0.80), hips: [externos([esq, dir])] };
            }
        } else {
            achado = acharTabelas(img, modelo);
            if (!achado) return { ok: false, motivo: 'Não consegui localizar as tabelas de respostas na foto.' };
        }
        const ref = melhorAlinhamento(img, [externos(achado.quads), ...(achado.hips || [])], modelo, achado.P);
        if (ref) {
            achado.quads = ref.quads.map((q, t) => refinarTabela(img, q, modelo, t, achado.P).quad);
            achado.pontuacao = ref.pontuacao;
        }
        const fracoes = [];
        for (let t = 0; t < 2; t++) {
            const f = medirTabela(img, achado.quads[t], modelo, t, achado.P);
            if (!f) return { ok: false, motivo: 'Não foi possível corrigir a perspectiva da foto.' };
            fracoes.push(...f);
        }
        const { respostas, revisar } = classificar(fracoes, modelo);
        // Alarmes de qualidade: o professor não pode confiar às cegas numa leitura desalinhada
        const umaMarcacao = fracoes.filter(fr => fr.filter(f => f > LIMIAR_MARCA).length === 1).length;
        const aproximada = !ref || ref.pontuacao < LIMIAR_ANEIS; // nem o refinamento por anéis achou as bolhas
        const alinhamento = Math.min(contrasteListras(img, achado.quads[0], modelo, 0, achado.P),
                                     contrasteListras(img, achado.quads[1], modelo, 1, achado.P));
        const desalinhada = alinhamento < LIMIAR_ALINHAMENTO;
        const muitasDuvidas = revisar.filter(Boolean).length > 0.15 * modelo.questoes; // antes de marcar tudo por 'aproximada'
        const suspeita = umaMarcacao < 0.6 * modelo.questoes || desalinhada || muitasDuvidas;
        if (aproximada) revisar.fill(true);
        return { ok: true, origem: achado.origem, quads: achado.quads, fracoes, respostas, revisar, aproximada, suspeita, desalinhada, alinhamento, umaMarcacao, pontuacao: achado.pontuacao };
    }

    // Imagem da tabela t com a perspectiva corrigida (para conferência visual)
    function normalizarTabela(img, quad, modelo) {
        const { W, H: Hh, pontos } = retanguloNormalizado(modelo);
        const H = homografia(pontos, quad);
        const data = new Uint8ClampedArray(W * Hh * 4);
        const rgb = [0, 0, 0];
        for (let y = 0; y < Hh; y++) {
            for (let x = 0; x < W; x++) {
                const [px, py] = aplicar(H, x, y);
                amostrar(img, px, py, rgb);
                const o = (y * W + x) * 4;
                data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
            }
        }
        return { width: W, height: Hh, data };
    }

    const api = {
        MODELO_GOIAS_40, LADO_MAIOR, LIMIAR_MARCA, lerCartao, normalizarTabela, centroBolha,
        // exportados para teste
        homografia, aplicar, ordenar, quad4, casco, classificar,
        _interno: { refinarAneis, pontuarAnéis, externos, cantosModelo, cinza, metade, suavizar, percentil, fechar, componentes, area, razaoQuad }
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    raiz.GabaritaLeitor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
