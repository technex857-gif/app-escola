/**
 * GABARITA — domínio (sem interface).
 *
 * Regras de negócio:
 * - RN01: '!' (rasura ou dupla marcação) invalida a questão; null é "em branco". Ambos não pontuam.
 * - RN02: Questões sem peso: conta-se a quantidade de acertos (1 a 60 questões).
 * - RN03: Só as respostas brutas são gravadas. Acertos, erros e percentuais são SEMPRE
 *         calculados a partir do gabarito atual (corrigir o gabarito atualiza as notas).
 * - RN04: Uma avaliação pode ter várias áreas (ex.: Biologia 1–13, Física 14–25). Cada
 *         área é um intervalo de questões, sem sobreposição. Todo resultado é calculado
 *         no total e por área.
 * - RN05: Hierarquia Turma → Avaliação → Correção. Os alunos pertencem à turma
 *         (nome e número de chamada) e valem para todas as avaliações dela; a correção é
 *         vinculada ao aluno (id) dentro de cada avaliação.
 */
(function (raiz) {
    'use strict';

    const LIMITE_MAX_QUESTOES = 60;
    const OPCOES_VALIDAS = ['A', 'B', 'C', 'D', 'E'];
    const CODIGO_RASURA = '!';
    const VERSAO = 6;
    const KEY = 'gabarita_v6';
    const KEY_V5 = 'gabarita_v5';
    const KEY_V4 = 'gabarita_v4';
    const KEY_V3 = 'gabarita_acertos_v3';
    const KEY_COPIA = 'gabarita_v4_copia_corrompida';
    const KEY_ANTES_IMPORTAR = 'gabarita_v4_antes_de_importar';
    const MODELO_AREAS_GOIAS_40 = [
        { nome: 'Biologia', inicio: 1, fim: 13 },
        { nome: 'Física', inicio: 14, fim: 25 },
        { nome: 'Química', inicio: 26, fim: 40 }
    ];

    // ------------------------------------------------------------------
    // Utilitários puros
    // ------------------------------------------------------------------
    const clonar = (x) => JSON.parse(JSON.stringify(x));

    // Normaliza texto digitado. Não remove pontuação (D'Ávila, "Matemática & Física" são válidos):
    // XSS é evitado renderizando sempre com textContent; fórmulas de CSV, em campoCsv().
    function limparTexto(texto, maxLen = 60) {
        if (typeof texto !== 'string') return '';
        return texto
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, maxLen);
    }

    // Campo CSV (separador ';'): neutraliza fórmulas (OWASP: = + - @ TAB CR) e escapa aspas.
    function campoCsv(valor) {
        if (typeof valor === 'number') return String(valor);
        let texto = valor === null || valor === undefined ? '' : String(valor);
        if (/^[=+\-@\t\r]/.test(texto)) texto = "'" + texto;
        if (/[;"\r\n]/.test(texto)) texto = '"' + texto.replace(/"/g, '""') + '"';
        return texto;
    }

    function nomeArquivoSeguro(titulo) {
        const base = String(titulo || '')
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        return base || 'avaliacao';
    }

    // Letra A–E, '!' (rasura/dupla) ou null (em branco)
    function normalizarResposta(valor) {
        if (OPCOES_VALIDAS.includes(valor)) return valor;
        if (valor === CODIGO_RASURA) return CODIGO_RASURA;
        return null;
    }

    // Lista de mensagens de erro; vazia se as áreas são válidas.
    // Permite questões fora de qualquer área, mas não sobreposição.
    function validarAreas(areas, total) {
        if (!Array.isArray(areas) || areas.length === 0) return ['Defina pelo menos uma área.'];
        const erros = [];
        const nomes = new Set();
        const usadaPor = Array(total).fill(null);
        areas.forEach((a, idx) => {
            const nome = limparTexto(a && a.nome, 30);
            const ini = Number(a && a.inicio);
            const fim = Number(a && a.fim);
            const rotulo = nome || `Área ${idx + 1}`;
            if (!nome) erros.push(`Área ${idx + 1}: informe o nome.`);
            else if (nomes.has(nome.toLowerCase())) erros.push(`Nome de área repetido: ${nome}.`);
            else nomes.add(nome.toLowerCase());

            if (!Number.isInteger(ini) || !Number.isInteger(fim) || ini < 1 || fim > total || ini > fim) {
                erros.push(`${rotulo}: informe um intervalo entre 1 e ${total} (início menor ou igual ao fim).`);
                return;
            }
            for (let q = ini; q <= fim; q++) {
                if (usadaPor[q - 1] !== null) {
                    erros.push(`${rotulo} se sobrepõe a ${usadaPor[q - 1]} na questão ${q}.`);
                    break;
                }
                usadaPor[q - 1] = rotulo;
            }
        });
        return erros;
    }

    function normalizarAreas(areas) {
        return areas.map((a, i) => ({
            id: i + 1,
            nome: limparTexto(a.nome, 30),
            inicio: Number(a.inicio),
            fim: Number(a.fim)
        }));
    }

    function contar(respostas, gabarito, de, ate) {
        let acertos = 0, erros = 0, brancos = 0, rasuras = 0;
        const divergencias = [];
        for (let i = de; i <= ate; i++) {
            const marcada = normalizarResposta(respostas[i]);
            const correta = gabarito[i] ?? null;
            const num = `Q${String(i + 1).padStart(2, '0')}`;
            if (marcada === null) {
                brancos++;
                divergencias.push(`${num}: em branco (correta ${correta})`);
            } else if (marcada === CODIGO_RASURA) {
                rasuras++;
                divergencias.push(`${num}: rasura/dupla marcação (correta ${correta})`);
            } else if (marcada === correta) {
                acertos++;
            } else {
                erros++;
                divergencias.push(`${num}: marcou ${marcada}, correta ${correta}`);
            }
        }
        const total = ate - de + 1;
        return { acertos, erros, brancos, rasuras, total, divergencias,
                 percentual: total > 0 ? Math.round((acertos / total) * 100) : 0 };
    }

    // Resultado total + por área
    function calcularResultado(respostas, gabarito, areas, total) {
        const geral = contar(respostas, gabarito, 0, total - 1);
        const porArea = (areas || []).map(a => {
            const r = contar(respostas, gabarito, a.inicio - 1, a.fim - 1);
            delete r.divergencias;
            return { id: a.id, nome: a.nome, inicio: a.inicio, fim: a.fim, ...r };
        });
        return { ...geral, porArea };
    }

    function novaAvaliacao(id, titulo = 'Nova avaliação', total = 10) {
        return {
            id,
            titulo: limparTexto(titulo, 50) || 'Nova avaliação',
            totalQuestoes: total,
            areas: [{ id: 1, nome: 'Geral', inicio: 1, fim: total }],
            gabarito: Array(total).fill(null),
            correcoes: {}
        };
    }

    // Saneia uma avaliação vinda do armazenamento ou de um backup. Nunca lança.
    function normalizarAvaliacao(bruta, id, avisos, idsAlunos) {
        const a = bruta && typeof bruta === 'object' ? bruta : {};
        let total = a.totalQuestoes;
        if (!Number.isInteger(total) || total < 1 || total > LIMITE_MAX_QUESTOES) {
            if (total !== undefined) avisos.push('quantidade de questões inválida');
            total = 10;
        }
        const av = novaAvaliacao(id, typeof a.titulo === 'string' ? a.titulo : undefined, total);

        if (Array.isArray(a.areas)) {
            const candidatas = normalizarAreas(a.areas.filter(x => x && typeof x === 'object'));
            if (validarAreas(candidatas, total).length === 0) av.areas = candidatas;
            else avisos.push('áreas inválidas (substituídas por "Geral")');
        }

        if (Array.isArray(a.gabarito)) {
            if (a.gabarito.length !== total) avisos.push('gabarito com tamanho diferente');
            av.gabarito = Array.from({ length: total }, (_, i) => (OPCOES_VALIDAS.includes(a.gabarito[i]) ? a.gabarito[i] : null));
        }

        if (a.correcoes && typeof a.correcoes === 'object') {
            for (const [chave, resp] of Object.entries(a.correcoes)) {
                const aid = Number(chave);
                if (!idsAlunos.has(aid) || !Array.isArray(resp)) { avisos.push('correção sem aluno correspondente ignorada'); continue; }
                av.correcoes[aid] = Array.from({ length: total }, (_, i) => normalizarResposta(resp[i]));
            }
        }
        return av;
    }

    // "12 - Ana Souza" → { numero: 12, nome: 'Ana Souza' }; sem número → numero null
    function lerLinhaAluno(linha) {
        const t = limparTexto(linha, 60);
        const m = t.match(/^(\d{1,3})\s*[-–.):]\s*(.+)$/);
        if (m && limparTexto(m[2], 60)) return { numero: Number(m[1]), nome: limparTexto(m[2], 60) };
        return { numero: null, nome: t };
    }

    // Saneia a lista de alunos da turma. Nomes e números de chamada não se repetem.
    function normalizarAlunos(lista, avisos) {
        const idsUsados = new Set(), nomes = new Set(), numeros = new Set();
        const alunos = [];
        let proximoId = 1;
        for (const al of Array.isArray(lista) ? lista : []) {
            let nome = al && typeof al.nome === 'string' ? limparTexto(al.nome, 60) : '';
            let numero = al && Number.isInteger(al.numero) && al.numero >= 1 && al.numero <= 999 ? al.numero : null;
            if (numero === null && nome) { const l = lerLinhaAluno(nome); nome = l.nome; numero = l.numero; }
            if (!nome || nomes.has(nome.toLowerCase())) { avisos.push('aluno inválido ou repetido ignorado'); continue; }
            let id = al && Number.isInteger(al.id) && al.id > 0 ? al.id : null;
            if (id === null || idsUsados.has(id)) { while (idsUsados.has(proximoId)) proximoId++; id = proximoId; }
            idsUsados.add(id); nomes.add(nome.toLowerCase());
            if (numero !== null && numeros.has(numero)) numero = null;
            if (numero !== null) numeros.add(numero);
            alunos.push({ id, nome, numero });
        }
        let livre = 1;
        for (const al of alunos) {
            if (al.numero === null) { while (numeros.has(livre)) livre++; al.numero = livre; numeros.add(livre); }
        }
        return ordenarAlunos(alunos);
    }

    const ordenarAlunos = (alunos) => alunos.sort((a, b) => a.numero - b.numero || a.id - b.id);

    const nomeOu = (v, padrao, max = 50) => limparTexto(typeof v === 'string' ? v : '', max) || padrao;

    // id único dentro de `usados`; aceita o pedido se for inteiro positivo ainda livre
    function idLivre(usados, pedido) {
        let id = Number.isInteger(pedido) && pedido > 0 && !usados.has(pedido) ? pedido : null;
        if (id === null) { id = 1; while (usados.has(id)) id++; }
        usados.add(id);
        return id;
    }

    function novaTurma(ids, nome) {
        return { id: idLivre(ids.turmas), nome, alunos: [], avaliacoes: [novaAvaliacao(idLivre(ids.avaliacoes))] };
    }

    // Saneia o estado completo (v6). Garante: ≥1 turma e, em cada turma, ≥1 avaliação.
    function normalizarEstado(dados) {
        const avisos = [];
        const ids = { turmas: new Set(), avaliacoes: new Set() };
        const turmas = [];
        for (const t of dados && Array.isArray(dados.turmas) ? dados.turmas : []) {
            const alunos = normalizarAlunos(t && t.alunos, avisos);
            const idsAlunos = new Set(alunos.map(x => x.id));
            const turma = { id: idLivre(ids.turmas, t && t.id), nome: nomeOu(t && t.nome, 'Turma'), alunos, avaliacoes: [] };
            for (const bruta of t && Array.isArray(t.avaliacoes) ? t.avaliacoes : []) {
                const id = idLivre(ids.avaliacoes, bruta && bruta.id);
                turma.avaliacoes.push(normalizarAvaliacao(bruta, id, avisos, idsAlunos));
            }
            if (turma.avaliacoes.length === 0) turma.avaliacoes.push(novaAvaliacao(idLivre(ids.avaliacoes)));
            turmas.push(turma);
        }
        if (turmas.length === 0) return { turmas, sel: null, avisos };

        // seleção: usa a pedida se existir; senão, a primeira de cada nível
        const pedido = (dados && dados.sel) || {};
        const turma = turmas.find(t => t.id === pedido.turmaId) || turmas[0];
        const av = turma.avaliacoes.find(a => a.id === pedido.avaliacaoId) || turma.avaliacoes[0];
        return { turmas, sel: { turmaId: turma.id, avaliacaoId: av.id }, avisos };
    }

    // v5 (matérias → turmas) → v6: a matéria deixa de existir; as turmas sobem um nível.
    // Se duas turmas ficarem com o mesmo nome, a matéria de origem é anexada ao nome para diferenciá-las.
    function migrarV5(d) {
        const todas = [];
        for (const m of d && Array.isArray(d.materias) ? d.materias : []) {
            for (const t of m && Array.isArray(m.turmas) ? m.turmas : []) todas.push({ t, materia: nomeOu(m && m.nome, '') });
        }
        const contagem = {};
        const chave = (n) => nomeOu(n, 'Turma').toLowerCase();
        todas.forEach(({ t }) => { contagem[chave(t && t.nome)] = (contagem[chave(t && t.nome)] || 0) + 1; });
        const turmas = todas.map(({ t, materia }) => {
            const nome = nomeOu(t && t.nome, 'Turma');
            const repetido = contagem[chave(nome)] > 1 && materia;
            return { ...(t || {}), nome: repetido ? limparTexto(`${nome} (${materia})`, 50) : nome };
        });
        return { turmas, sel: d && d.sel };
    }

    // v4 (lista de avaliações, cada uma com seus alunos) → v6. Sem perda: cada avaliação antiga
    // vira uma turma (com o mesmo nome).
    function migrarV4(d) {
        const lista = d && Array.isArray(d.avaliacoes) ? d.avaliacoes : [];
        const turmas = lista.map((a, i) => {
            const { alunos, ...avaliacao } = a && typeof a === 'object' ? a : {};
            const titulo = nomeOu(avaliacao.titulo, `Turma ${i + 1}`);
            return { id: i + 1, nome: titulo, alunos: Array.isArray(alunos) ? alunos : [], avaliacoes: [{ ...avaliacao, id: i + 1 }] };
        });
        const idx = lista.findIndex(a => a && a.id === d.atualId);
        const atual = turmas[idx >= 0 ? idx : 0];
        return { turmas, sel: atual ? { turmaId: atual.id, avaliacaoId: atual.avaliacoes[0].id } : null };
    }

    // Converte o formato da versão anterior (uma única avaliação)
    function migrarV3(d) {
        const total = Number.isInteger(d && d.totalQuestoes) ? d.totalQuestoes : 10;
        const alunos = [];
        const correcoes = {};
        if (d && Array.isArray(d.alunosCorrigidos)) {
            d.alunosCorrigidos.forEach((al, i) => {
                alunos.push({ id: i + 1, nome: al && al.nome });
                correcoes[i + 1] = al && al.respostas;
            });
        }
        return normalizarEstado(migrarV4({
            avaliacoes: [{ id: 1, titulo: d && d.titulo, totalQuestoes: total, gabarito: d && d.gabaritoMestre, alunos, correcoes }],
            atualId: 1
        }));
    }

    // ------------------------------------------------------------------
    // Gerenciador (estado + persistência)
    // ------------------------------------------------------------------
    class Gerenciador {
        #storage;
        #estado = { turmas: [], sel: null };
        #rascunho = null; // { alunoId, respostas, origem }
        #falhaNotificada = false;

        onErroPersistencia = null;
        avisoCarga = '';

        constructor(storage = raiz.localStorage) {
            this.#storage = storage;
            this.#carregar();
        }

        // ---- navegação: turma → avaliação ------------------------------
        #turma() { return this.#estado.turmas.find(t => t.id === this.#estado.sel.turmaId); }
        #atual() { return this.#turma().avaliacoes.find(a => a.id === this.#estado.sel.avaliacaoId); }
        #ids() {
            const ids = { turmas: new Set(), avaliacoes: new Set() };
            for (const t of this.#estado.turmas) { ids.turmas.add(t.id); t.avaliacoes.forEach(a => ids.avaliacoes.add(a.id)); }
            return ids;
        }
        #proximoId(conjunto) { return Math.max(0, ...conjunto) + 1; }
        // Seleciona a turma (e a 1ª avaliação dela)
        #irParaTurma(turma) {
            this.#estado.sel = { turmaId: turma.id, avaliacaoId: turma.avaliacoes[0].id };
            this.#rascunho = null;
        }

        get turmas() { return this.#estado.turmas.map(t => ({ id: t.id, nome: t.nome, alunos: t.alunos.length, avaliacoes: t.avaliacoes.length })); }
        get turmaId() { return this.#estado.sel.turmaId; }
        get contexto() {
            return {
                turma: { id: this.#turma().id, nome: this.#turma().nome },
                avaliacao: { id: this.#atual().id, titulo: this.#atual().titulo }
            };
        }
        // A avaliação atual, com os alunos da turma
        get avaliacao() { return clonar({ ...this.#atual(), alunos: this.#turma().alunos }); }
        get avaliacoes() { return this.#turma().avaliacoes.map(a => ({ id: a.id, titulo: a.titulo })); }
        get atualId() { return this.#estado.sel.avaliacaoId; }
        get gabaritoEstaCompleto() {
            const a = this.#atual();
            return a.gabarito.length === a.totalQuestoes && a.gabarito.every(r => OPCOES_VALIDAS.includes(r));
        }
        get rascunho() { return this.#rascunho ? clonar(this.#rascunho) : null; }
        get rascunhoTemMarcacoes() { return !!this.#rascunho && this.#rascunho.respostas.some(r => r !== null); }

        // ---- turmas --------------------------------------------------
        selecionarTurma(id) {
            const t = this.#estado.turmas.find(x => x.id === id);
            if (!t) throw new Error('Turma não encontrada.');
            this.#irParaTurma(t);
            this.salvarDados();
        }

        criarTurma(nome) {
            const t = novaTurma(this.#ids(), nomeOu(nome, 'Nova turma'));
            this.#estado.turmas.push(t);
            this.#irParaTurma(t);
            this.salvarDados();
            return t.id;
        }

        renomearTurma(nome) {
            const limpo = limparTexto(nome, 50);
            if (limpo) { this.#turma().nome = limpo; this.salvarDados(); }
        }

        excluirTurma(id) {
            this.#estado.turmas = this.#estado.turmas.filter(t => t.id !== id);
            if (this.#estado.turmas.length === 0) this.#estado.turmas.push(novaTurma({ turmas: new Set(), avaliacoes: new Set() }, 'Turma 1'));
            const t = this.#estado.turmas.find(x => x.id === this.#estado.sel.turmaId) || this.#estado.turmas[0];
            this.#irParaTurma(t);
            this.salvarDados();
        }

        // ---- avaliações (da turma atual) -------------------------------
        selecionarAvaliacao(id) {
            if (!this.#turma().avaliacoes.some(a => a.id === id)) throw new Error('Avaliação não encontrada.');
            this.#estado.sel.avaliacaoId = id;
            this.#rascunho = null;
            this.salvarDados();
        }

        criarAvaliacao(titulo) {
            const id = this.#proximoId(this.#ids().avaliacoes);
            this.#turma().avaliacoes.push(novaAvaliacao(id, titulo));
            this.#estado.sel.avaliacaoId = id;
            this.#rascunho = null;
            this.salvarDados();
            return id;
        }

        excluirAvaliacao(id) {
            const t = this.#turma();
            t.avaliacoes = t.avaliacoes.filter(a => a.id !== id);
            if (t.avaliacoes.length === 0) t.avaliacoes.push(novaAvaliacao(this.#proximoId(this.#ids().avaliacoes)));
            if (!t.avaliacoes.some(a => a.id === this.#estado.sel.avaliacaoId)) this.#estado.sel.avaliacaoId = t.avaliacoes[0].id;
            this.#rascunho = null;
            this.salvarDados();
        }

        definirTitulo(novo) {
            const limpo = limparTexto(novo, 50);
            if (limpo) { this.#atual().titulo = limpo; this.salvarDados(); }
        }

        // true se alterou; false se há correções e falta autorização para apagá-las
        alterarQuantidadeQuestoes(novaQtd, forcarLimpeza = false) {
            const qtd = Number.parseInt(novaQtd, 10);
            if (Number.isNaN(qtd) || qtd < 1 || qtd > LIMITE_MAX_QUESTOES) {
                throw new Error(`A quantidade de questões deve ser entre 1 e ${LIMITE_MAX_QUESTOES}.`);
            }
            const a = this.#atual();
            if (qtd === a.totalQuestoes) return true;
            if (Object.keys(a.correcoes).length > 0 && !forcarLimpeza) return false;
            if (forcarLimpeza) a.correcoes = {};

            const antigo = a.totalQuestoes;
            const gab = Array(qtd).fill(null);
            for (let i = 0; i < Math.min(antigo, qtd); i++) gab[i] = a.gabarito[i];
            a.gabarito = gab;
            a.totalQuestoes = qtd;

            // Área única que cobria tudo continua cobrindo tudo; as demais são ajustadas ao novo limite
            if (a.areas.length === 1 && a.areas[0].inicio === 1 && a.areas[0].fim === antigo) {
                a.areas[0].fim = qtd;
            } else {
                a.areas = a.areas
                    .filter(x => x.inicio <= qtd)
                    .map(x => ({ ...x, fim: Math.min(x.fim, qtd) }));
                if (a.areas.length === 0) a.areas = [{ id: 1, nome: 'Geral', inicio: 1, fim: qtd }];
            }
            this.#rascunho = null;
            this.salvarDados();
            return true;
        }

        definirAreas(areas) {
            const a = this.#atual();
            const lista = (Array.isArray(areas) ? areas : []).map(x => ({
                nome: limparTexto(x && x.nome, 30), inicio: Number(x && x.inicio), fim: Number(x && x.fim)
            }));
            const erros = validarAreas(lista, a.totalQuestoes);
            if (erros.length) throw new Error(erros.join(' '));
            a.areas = normalizarAreas(lista);
            this.salvarDados();
        }

        marcarGabarito(indice, letra) {
            const a = this.#atual();
            if (indice >= 0 && indice < a.totalQuestoes && OPCOES_VALIDAS.includes(letra)) {
                a.gabarito[indice] = letra;
                this.salvarDados();
            }
        }

        // Substitui o gabarito inteiro (ex.: lido pela câmera e conferido). Só aceita A–E em todas as questões.
        definirGabarito(respostas) {
            const a = this.#atual();
            if (!Array.isArray(respostas) || respostas.length !== a.totalQuestoes || !respostas.every(r => OPCOES_VALIDAS.includes(r))) {
                throw new Error('O gabarito precisa ter uma alternativa (A–E) em todas as questões.');
            }
            a.gabarito = [...respostas];
            this.salvarDados();
        }

        // ---- alunos (da turma) -----------------------------------------
        // Um aluno por linha, "nome" ou "nº - nome". Ignora vazias, nomes repetidos e números já usados.
        adicionarAlunos(texto) {
            const t = this.#turma();
            const nomes = new Set(t.alunos.map(x => x.nome.toLowerCase()));
            const numeros = new Set(t.alunos.map(x => x.numero));
            let proximoId = t.alunos.reduce((m, x) => Math.max(m, x.id), 0) + 1;
            let livre = 1;
            let adicionados = 0, ignorados = 0;
            for (const linha of String(texto || '').split(/\r?\n/)) {
                const { numero: pedido, nome } = lerLinhaAluno(linha);
                if (!nome) continue;
                if (nomes.has(nome.toLowerCase()) || (pedido !== null && numeros.has(pedido))) { ignorados++; continue; }
                let numero = pedido;
                if (numero === null) { while (numeros.has(livre)) livre++; numero = livre; }
                nomes.add(nome.toLowerCase()); numeros.add(numero);
                t.alunos.push({ id: proximoId++, nome, numero });
                adicionados++;
            }
            if (adicionados) { ordenarAlunos(t.alunos); this.salvarDados(); }
            return { adicionados, ignorados };
        }

        // Altera nome e/ou número de chamada. Lança erro se ficar vazio ou repetir outro aluno.
        editarAluno(id, { nome, numero } = {}) {
            const t = this.#turma();
            const al = t.alunos.find(x => x.id === id);
            if (!al) throw new Error('Aluno não encontrado.');
            const novoNome = nome === undefined ? al.nome : limparTexto(nome, 60);
            const novoNumero = numero === undefined ? al.numero : Number(numero);
            if (!novoNome) throw new Error('O nome não pode ficar vazio.');
            if (!Number.isInteger(novoNumero) || novoNumero < 1 || novoNumero > 999) throw new Error('O número de chamada deve ser de 1 a 999.');
            if (t.alunos.some(x => x.id !== id && x.nome.toLowerCase() === novoNome.toLowerCase())) throw new Error('Já existe um aluno com esse nome.');
            if (t.alunos.some(x => x.id !== id && x.numero === novoNumero)) throw new Error('Já existe um aluno com esse número de chamada.');
            al.nome = novoNome; al.numero = novoNumero;
            ordenarAlunos(t.alunos);
            this.salvarDados();
        }

        // Remove o aluno e suas correções em todas as avaliações da turma
        removerAluno(id) {
            const t = this.#turma();
            t.alunos = t.alunos.filter(x => x.id !== id);
            for (const a of t.avaliacoes) delete a.correcoes[id];
            if (this.#rascunho && this.#rascunho.alunoId === id) this.#rascunho = null;
            this.salvarDados();
        }

        // Alunos que casam com o texto: número de chamada exato ou parte do nome (sem acentos/maiúsculas)
        buscarAluno(texto) {
            const norm = (v) => String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
            const q = norm(texto || '');
            if (!q) return [];
            const alunos = this.#turma().alunos;
            if (/^\d+$/.test(q)) {
                const exato = alunos.filter(x => x.numero === Number(q));
                if (exato.length) return clonar(exato);
            }
            return clonar(alunos.filter(x => norm(x.nome).includes(q)));
        }

        foiCorrigido(alunoId) { return Object.hasOwn(this.#atual().correcoes, alunoId); }

        // Próximo aluno sem correção depois de `aposId` (circular); null se todos corrigidos
        proximoAlunoPendente(aposId = null) {
            const a = this.#atual();
            const alunos = this.#turma().alunos;
            const n = alunos.length;
            if (n === 0) return null;
            let inicio = alunos.findIndex(x => x.id === aposId) + 1; // -1 + 1 = 0 se não achar
            for (let k = 0; k < n; k++) {
                const al = alunos[(inicio + k) % n];
                if (!Object.hasOwn(a.correcoes, al.id)) return al.id;
            }
            return null;
        }

        // ---- correção (rascunho) -------------------------------------
        // `respostas` opcional: leitura automática. Sem ela, começa tudo em branco.
        iniciarRascunho(alunoId, respostas = null, origem = 'manual') {
            const a = this.#atual();
            if (!this.gabaritoEstaCompleto) {
                throw new Error('Preencha todas as questões do Gabarito antes de corrigir um aluno.');
            }
            if (!this.#turma().alunos.some(x => x.id === alunoId)) throw new Error('Aluno não encontrado.');
            // Leitura automática manda; sem ela, recorrigir parte da correção salva; senão, tudo em branco
            let base = [];
            if (Array.isArray(respostas)) base = respostas;
            else if (this.foiCorrigido(alunoId)) base = a.correcoes[alunoId];
            this.#rascunho = {
                alunoId,
                origem,
                respostas: Array.from({ length: a.totalQuestoes }, (_, i) => normalizarResposta(base[i]))
            };
        }

        descartarRascunho() { this.#rascunho = null; }

        // Tocar na opção já marcada deixa a questão em branco
        ajustarRascunho(indice, valor) {
            const r = this.#rascunho;
            if (!r || indice < 0 || indice >= r.respostas.length) return;
            if (!OPCOES_VALIDAS.includes(valor) && valor !== CODIGO_RASURA) return;
            r.respostas[indice] = r.respostas[indice] === valor ? null : valor;
        }

        resultadoRascunho() {
            const a = this.#atual();
            if (!this.#rascunho) return null;
            return calcularResultado(this.#rascunho.respostas, a.gabarito, a.areas, a.totalQuestoes);
        }

        salvarRascunho() {
            const a = this.#atual();
            const r = this.#rascunho;
            if (!r) throw new Error('Não há correção em andamento.');
            a.correcoes[r.alunoId] = [...r.respostas];
            const resultado = calcularResultado(r.respostas, a.gabarito, a.areas, a.totalQuestoes);
            const alunoId = r.alunoId;
            this.#rascunho = null;
            this.salvarDados();
            return { alunoId, ...resultado };
        }

        removerCorrecao(alunoId) {
            delete this.#atual().correcoes[alunoId];
            this.salvarDados();
        }

        resultadoDoAluno(alunoId) {
            const a = this.#atual();
            if (!Object.hasOwn(a.correcoes, alunoId)) return null;
            return calcularResultado(a.correcoes[alunoId], a.gabarito, a.areas, a.totalQuestoes);
        }

        // ---- estatísticas e exportação -------------------------------
        estatisticas() {
            const a = this.#atual();
            const alunos = this.#turma().alunos;
            const corrigidos = alunos.filter(x => Object.hasOwn(a.correcoes, x.id));
            const n = corrigidos.length;
            const resultados = corrigidos.map(x => calcularResultado(a.correcoes[x.id], a.gabarito, a.areas, a.totalQuestoes));
            const soma = (f) => resultados.reduce((s, r) => s + f(r), 0);

            const areaDe = (q) => (a.areas.find(x => q >= x.inicio && q <= x.fim) || {}).nome || '';
            return {
                totalAlunos: alunos.length,
                corrigidos: n,
                mediaAcertos: n ? soma(r => r.acertos) / n : 0,
                mediaPercentual: n ? soma(r => r.percentual) / n : 0,
                porArea: a.areas.map((ar, idx) => {
                    const total = ar.fim - ar.inicio + 1;
                    const media = n ? soma(r => r.porArea[idx].acertos) / n : 0;
                    return { id: ar.id, nome: ar.nome, total, mediaAcertos: media, percentualMedio: n ? (media / total) * 100 : 0 };
                }),
                porQuestao: Array.from({ length: a.totalQuestoes }, (_, i) => {
                    const acertou = corrigidos.filter(x => a.correcoes[x.id][i] === a.gabarito[i]).length;
                    return { numero: i + 1, area: areaDe(i + 1), gabarito: a.gabarito[i],
                             percentualAcerto: n ? Math.round((acertou / n) * 100) : 0 };
                })
            };
        }

        csv() {
            const a = this.#atual();
            const comAreas = a.areas.length > 1;
            const ctx = this.contexto;
            const cab = ['Turma', 'Avaliacao', 'Numero', 'Aluno', 'Total de Questoes', 'Acertos', 'Erros', 'Brancos', 'Rasuras', 'Aproveitamento (%)'];
            if (comAreas) a.areas.forEach(ar => cab.push(`${ar.nome} - Acertos (de ${ar.fim - ar.inicio + 1})`, `${ar.nome} - %`));
            cab.push('Respostas (. = branco, ! = rasura)');
            const linhas = [];
            for (const al of this.#turma().alunos) {
                const r = this.resultadoDoAluno(al.id);
                if (!r) continue;
                const linha = [ctx.turma.nome, a.titulo, al.numero, al.nome, a.totalQuestoes, r.acertos, r.erros, r.brancos, r.rasuras, r.percentual];
                if (comAreas) r.porArea.forEach(p => linha.push(p.acertos, p.percentual));
                linha.push(a.correcoes[al.id].map(x => x ?? '.').join('-'));
                linhas.push(linha);
            }
            return '﻿' + [cab, ...linhas].map(l => l.map(campoCsv).join(';')).join('\r\n') + '\r\n';
        }

        exportarBackup() {
            return {
                app: 'gabarita', versao: VERSAO, exportadoEm: new Date().toISOString(),
                sel: clonar(this.#estado.sel), turmas: clonar(this.#estado.turmas)
            };
        }

        // Substitui TODOS os dados atuais. Guarda uma cópia dos dados anteriores antes de trocar.
        // Aceita backups da versão atual (materias) e da anterior (avaliacoes).
        importarBackup(entrada) {
            let dados = entrada;
            if (typeof entrada === 'string') {
                try { dados = JSON.parse(entrada); } catch (e) { throw new Error('O arquivo não é um backup válido (JSON ilegível).'); }
            }
            const ok = (k) => !!dados && Array.isArray(dados[k]) && dados[k].length > 0;
            if (!dados || dados.app !== 'gabarita' || !(ok('turmas') || ok('materias') || ok('avaliacoes'))) throw new Error('O arquivo não é um backup do Gabarita.');
            const novo = normalizarEstado(ok('turmas') ? dados : ok('materias') ? migrarV5(dados) : migrarV4(dados));
            if (novo.turmas.length === 0) throw new Error('O backup não contém dados válidos.');
            try {
                this.#storage.setItem(KEY_ANTES_IMPORTAR, JSON.stringify(this.exportarBackup()));
            } catch (e) { console.error('Não foi possível guardar cópia antes de importar:', e); }
            this.#estado = { turmas: novo.turmas, sel: novo.sel };
            this.#rascunho = null;
            this.salvarDados();
            const avaliacoes = novo.turmas.reduce((n, t) => n + t.avaliacoes.length, 0);
            return { turmas: novo.turmas.length, avaliacoes, avisos: [...new Set(novo.avisos)] };
        }

        limparTudo() {
            this.#padrao();
            this.#rascunho = null;
            try { this.#storage.removeItem(KEY); } catch (e) { console.error('Erro ao limpar:', e); }
        }

        // ---- persistência --------------------------------------------
        salvarDados() {
            try {
                this.#storage.setItem(KEY, JSON.stringify({
                    versao: VERSAO, sel: this.#estado.sel, turmas: this.#estado.turmas
                }));
                this.#falhaNotificada = false;
                return true;
            } catch (err) {
                console.error('Erro ao salvar no navegador:', err);
                if (!this.#falhaNotificada) {
                    this.#falhaNotificada = true;
                    if (typeof this.onErroPersistencia === 'function') this.onErroPersistencia(err);
                }
                return false;
            }
        }

        #preservarCopia(bruto) {
            try { this.#storage.setItem(KEY_COPIA, bruto); } catch (e) { console.error('Cópia não preservada:', e); }
        }

        #padrao() {
            const t = novaTurma({ turmas: new Set(), avaliacoes: new Set() }, 'Turma 1');
            this.#estado = { turmas: [t], sel: { turmaId: t.id, avaliacaoId: t.avaliacoes[0].id } };
        }

        #carregar() {
            let bruto, brutoV5, brutoV4, brutoV3;
            try {
                bruto = this.#storage.getItem(KEY);
                if (!bruto) brutoV5 = this.#storage.getItem(KEY_V5);
                if (!bruto && !brutoV5) brutoV4 = this.#storage.getItem(KEY_V4);
                if (!bruto && !brutoV5 && !brutoV4) brutoV3 = this.#storage.getItem(KEY_V3);
            } catch (err) {
                this.#padrao();
                this.avisoCarga = 'Não foi possível acessar o armazenamento do navegador. Os dados desta sessão não serão salvos.';
                return;
            }

            // Versões anteriores: migra para a atual e MANTÉM a chave antiga intacta (volta possível)
            const legado = !bruto && (brutoV5 || brutoV4 || brutoV3);
            if (legado) {
                try {
                    const novo = brutoV5 ? normalizarEstado(migrarV5(JSON.parse(brutoV5)))
                        : brutoV4 ? normalizarEstado(migrarV4(JSON.parse(brutoV4)))
                        : migrarV3(JSON.parse(brutoV3));
                    if (novo.turmas.length === 0) throw new Error('vazio');
                    if (novo.avisos.length) this.#preservarCopia(legado);
                    this.#estado = { turmas: novo.turmas, sel: novo.sel };
                    this.avisoCarga = brutoV5
                        ? 'Seus dados foram atualizados: a matéria foi removida e as turmas ficaram na raiz.'
                        : brutoV4 ? 'Seus dados foram migrados: cada avaliação anterior virou uma turma.'
                        : 'Dados da versão anterior foram importados para a nova versão.';
                    this.salvarDados();
                    return;
                } catch (err) {
                    this.#preservarCopia(legado);
                    this.#padrao();
                    this.avisoCarga = 'Os dados da versão anterior estavam ilegíveis. Uma cópia foi preservada no navegador.';
                    return;
                }
            }
            if (!bruto) { this.#padrao(); return; }

            let dados = null;
            try { dados = JSON.parse(bruto); } catch (err) { dados = null; }
            if (!dados || typeof dados !== 'object' || !Array.isArray(dados.turmas)) {
                this.#preservarCopia(bruto);
                this.#padrao();
                this.avisoCarga = 'Os dados salvos estavam ilegíveis e foram ignorados. Uma cópia foi preservada no navegador.';
                return;
            }
            const novo = normalizarEstado(dados);
            if (novo.turmas.length === 0) { this.#preservarCopia(bruto); this.#padrao(); return; }
            this.#estado = { turmas: novo.turmas, sel: novo.sel };
            if (novo.avisos.length) {
                this.#preservarCopia(bruto);
                this.avisoCarga = 'Parte dos dados salvos estava inconsistente e foi corrigida. Uma cópia original foi preservada no navegador.';
            }
        }
    }

    const api = {
        Gerenciador, calcularResultado, validarAreas, campoCsv, limparTexto, nomeArquivoSeguro,
        normalizarResposta, MODELO_AREAS_GOIAS_40, OPCOES_VALIDAS, CODIGO_RASURA, LIMITE_MAX_QUESTOES
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    raiz.GabaritaDominio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
