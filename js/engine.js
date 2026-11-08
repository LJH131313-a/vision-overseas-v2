/*! 远见·企业出海助手 —— 规则引擎与税费引擎
 * 语义约定（与原始交付数据包一致）：
 *  - 三值逻辑：条件明确满足 applicable / 明确不满足 not_applicable / 必要事实缺失 unknown；
 *  - unknown 不按 false 处理；缺失事实只阻断相关规则，并回传缺失字段；
 *  - 法域只加载目的地及其显式 inherits_from 上位法域，不允许跨法域默认替代；
 *  - 规则按投放市场/进口日期选版本，超出适用期按不适用并给出原因；
 *  - 只有 applicable（含 review_required）规则生成行动与材料；
 *  - 税费完整总额仅在全部安全门通过时输出；关键条件缺失不按零处理。
 */
(function (global) {
  'use strict';

  var SNAPSHOT_DATE = '2026-11-04';
  var UNKNOWN = 'unknown';

  /* ================= 条件 DSL ================= */
  function isUnknown(v) { return v === null || v === undefined || v === ''; }

  function evaluateCondition(node, facts, missing) {
    if (!node || !node.op) return true;
    var args = Array.isArray(node.args) ? node.args : [];

    if (node.op === 'all') {
      var sawUnknownAll = false;
      for (var i = 0; i < args.length; i++) {
        var r = evaluateCondition(args[i], facts, missing);
        if (r === false) return false;
        if (r === UNKNOWN) sawUnknownAll = true;
      }
      return sawUnknownAll ? UNKNOWN : true;
    }
    if (node.op === 'any') {
      var sawUnknownAny = false;
      for (var j = 0; j < args.length; j++) {
        var r2 = evaluateCondition(args[j], facts, missing);
        if (r2 === true) return true;
        if (r2 === UNKNOWN) sawUnknownAny = true;
      }
      return sawUnknownAny ? UNKNOWN : false;
    }

    var actual = facts[node.field];
    if (isUnknown(actual)) { if (missing) missing.add(node.field); return UNKNOWN; }

    switch (node.op) {
      case 'eq': return actual === node.value;
      case 'ne': return actual !== node.value;
      case 'in': return Array.isArray(node.value) && node.value.indexOf(actual) >= 0;
      case 'gt': return Number(actual) > Number(node.value);
      case 'ge': return Number(actual) >= Number(node.value);
      case 'lt': return Number(actual) < Number(node.value);
      case 'le': return Number(actual) <= Number(node.value);
      case 'between': return Number(actual) >= Number(node.min) && Number(actual) <= Number(node.max);
      case 'contains_any': {
        var values = Array.isArray(actual) ? actual : String(actual).split(/[|;,]/).map(function (x) { return x.trim(); });
        return Array.isArray(node.value) && node.value.some(function (v) { return values.indexOf(v) >= 0; });
      }
      case 'date_ge': return String(actual) >= String(node.value);
      case 'date_le': return String(actual) <= String(node.value);
      default: return UNKNOWN;
    }
  }

  function statusFor(rule, conditionResult, exclusionResult) {
    if (exclusionResult === true) return 'not_applicable';
    if (conditionResult === false) return 'not_applicable';
    if (conditionResult === UNKNOWN) return 'unknown';
    if (rule.status === 'review_required') return 'review_required';
    return 'applicable';
  }

  /* ================= 法域链 ================= */
  function jurisdictionChain(data, market) {
    var byCode = {};
    data.jurisdictions.forEach(function (j) { byCode[j.code] = j; });
    var chain = [], seen = {}, queue = [market];
    while (queue.length) {
      var code = queue.shift();
      if (!code || seen[code]) continue;
      seen[code] = true; chain.push(code);
      var node = byCode[code];
      if (node && Array.isArray(node.inherits)) node.inherits.forEach(function (p) { queue.push(p); });
    }
    return chain;
  }

  /* ================= 场景评估 ================= */
  /**
   * @param data   window.VO_DATA
   * @param opts   { market, subcategoryId, facts, placingOnMarketDate }
   */
  function evaluateScenario(data, opts) {
    var market = opts.market || '';
    var subId = opts.subcategoryId || '';
    var facts = Object.assign({}, opts.facts || {});
    var sub = null;
    data.subcategories.forEach(function (s) { if (s.id === subId) sub = s; });
    var legacy = sub ? sub.legacy : (facts.product_type || '');
    // 仅给旧产品类型时按 legacy 解析唯一小类（多个匹配则不解析，避免歧义）
    if (!sub && legacy) {
      var matches = data.subcategories.filter(function (s) { return s.legacy === legacy; });
      if (matches.length === 1) sub = matches[0];
    }
    if (sub) { subId = sub.id; legacy = sub.legacy || legacy; }

    var normalized = Object.assign({}, facts, {
      market: market,
      jurisdiction: market,
      subcategory_id: subId,
      product_type: legacy,
      placing_on_market_date: opts.placingOnMarketDate || ''
    });
    // 旧正式项目字段别名（与原始引擎一致）
    if (normalized.wireless !== undefined && normalized.wireless_present === undefined) normalized.wireless_present = normalized.wireless;
    if (normalized.battery !== undefined && normalized.battery_present === undefined) normalized.battery_present = normalized.battery;
    if (normalized.end_use !== undefined && normalized.consumer_product === undefined) normalized.consumer_product = normalized.end_use === 'consumer';
    if (normalized.channel !== undefined && normalized.offered_online === undefined) normalized.offered_online = ['DTC', 'marketplace', 'online'].indexOf(normalized.channel) >= 0;

    var chain = jurisdictionChain(data, market);
    var linked = {};
    data.productRuleLinks.forEach(function (l) { if (l.sub === subId) linked[l.ruleId] = true; });

    var candidates = data.rules.filter(function (rule) {
      var j = rule.jurisdiction || rule.market;
      if (!(j === 'ALL' || chain.indexOf(j) >= 0)) return false;
      if (rule.origin === 'task3_verified_rule') return !!linked[rule.id];
      return true; // 正式项目 / 扩展规则按市场条件自筛
    });

    var asOf = normalized.placing_on_market_date || SNAPSHOT_DATE;
    var results = candidates.map(function (rule) {
      var missing = new Set();
      var conditionResult = evaluateCondition(rule.condition, normalized, missing);
      var exclusionResult = rule.exclusions ? evaluateCondition(rule.exclusions, normalized, missing) : false;
      var state = statusFor(rule, conditionResult, exclusionResult);
      var dateActive = (!rule.effectiveFrom || asOf >= rule.effectiveFrom) && (!rule.effectiveTo || asOf <= rule.effectiveTo);
      var out = Object.assign({}, rule, { state: state, missingFields: Array.from(missing) });
      if (!dateActive) {
        out.dateActive = false;
        out.dateReason = (!rule.effectiveFrom || asOf >= rule.effectiveFrom)
          ? '规则适用期至 ' + rule.effectiveTo + '，不覆盖 ' + asOf
          : '规则自 ' + rule.effectiveFrom + ' 起适用，尚不覆盖 ' + asOf;
        if (state === 'applicable' || state === 'review_required') out.state = 'not_applicable';
      } else {
        out.dateActive = true;
      }
      return out;
    });

    var applicable = results.filter(function (r) { return r.state === 'applicable' || r.state === 'review_required'; });
    var unknown = results.filter(function (r) { return r.state === 'unknown'; });
    var excluded = results.filter(function (r) { return r.state === 'not_applicable'; });

    var actionIds = [], materialIds = [];
    applicable.forEach(function (r) {
      (r.actions || []).forEach(function (a) { if (actionIds.indexOf(a) < 0) actionIds.push(a); });
      (r.materials || []).forEach(function (m) { if (materialIds.indexOf(m) < 0) materialIds.push(m); });
    });
    var sourceIds = [];
    applicable.concat(unknown).forEach(function (r) {
      (r.sourceIds || []).forEach(function (s) { if (sourceIds.indexOf(s) < 0) sourceIds.push(s); });
    });

    var missingFields = [];
    unknown.forEach(function (r) { (r.missingFields || []).forEach(function (f) { if (missingFields.indexOf(f) < 0) missingFields.push(f); }); });

    // 覆盖画像：先查静态画像（市场|legacy），否则按“非 M1 且链内有任务三规则”生成 L2
    var cov = coverageFor(data, market, sub, legacy, chain, linked);

    // HS 候选：小类/旧类型/覆盖画像 productId 三路匹配（覆盖画像承载旧 product_id 桥接）
    var covBridge = null;
    data.coverageProfiles.forEach(function (c) { if (c.market === market && c.legacy === legacy) covBridge = c; });
    var hs = data.hsCandidates.filter(function (x) {
      return x.market === market && (x.legacyProduct === legacy
        || (sub && x.legacyProduct === sub.id)
        || (covBridge && covBridge.productId && x.legacyProduct === covBridge.productId));
    });

    // 待规则核验：法域链内法规索引中尚无可执行规则者（导航级）
    var ruleReadyIds = {};
    data.rules.forEach(function (r) { ruleReadyIds[r.regulationId] = true; });
    var pendingRules = data.regulations.filter(function (reg) {
      if (chain.indexOf(reg.jurisdiction) < 0) return false;
      if (reg.ruleIds && reg.ruleIds.length) return false;
      return true;
    });

    var gaps = [];
    if (!cov) gaps.push('当前「产品小类 × 目的地」组合暂无产品特定结构化规则，仅可使用法规资料检索与通用风险提示（L1）。');
    if (cov && !hs.length) gaps.push('当前组合尚无经来源关联的目的国 HS 候选。');
    if (cov && cov.level === 'L2') gaps.push('本组合为 L2 结构化初筛：可运行条件规则，但税额与部分主题可能因数据不足被阻断。');
    if (pendingRules.length) gaps.push('目的法域有 ' + pendingRules.length + ' 条法规仅有索引级核验，尚未形成可自动执行的条款规则，需人工核对原文。');

    // 动态追问（缺失字段 → 字段定义 + 影响规则）
    var questions = missingFields.map(function (key) {
      var f = null;
      data.fields.forEach(function (x) { if (x.key === key || x.ruleKey === key) f = x; });
      if (!f && data.ruleFields) data.ruleFields.forEach(function (x) { if (x.key === key) f = x; });
      if (!f) return null;
      var affected = unknown.filter(function (r) { return (r.missingFields || []).indexOf(key) >= 0; }).map(function (r) { return r.id; });
      return { field: f, affectedRules: affected };
    }).filter(Boolean);

    return {
      snapshotDate: SNAPSHOT_DATE,
      asOf: asOf,
      market: market,
      subcategory: sub,
      legacy: legacy,
      jurisdictionChain: chain,
      results: results,
      applicableRules: applicable,
      unknownRules: unknown,
      excludedRules: excluded,
      actionList: data.actions.filter(function (a) { return actionIds.indexOf(a.id) >= 0; }),
      materialList: data.materials.filter(function (m) { return materialIds.indexOf(m.id) >= 0; }),
      sourceIds: sourceIds,
      missingFields: missingFields,
      questions: questions,
      coverage: cov ? { level: cov.level, label: cov.label } : { level: 'L1', label: '资料导航' },
      coverageDefinition: coverageText(cov ? cov.level : 'L1', data),
      hsCandidates: hs,
      pendingRegulations: pendingRules,
      gaps: gaps
    };
  }

  function coverageText(level, data) {
    var def = data.meta && data.meta.levels && data.meta.levels[level];
    return def || '';
  }

  /**
   * 覆盖等级判定（与原始交付语义一致）：
   *  - 静态画像命中且为 L3 → 直接使用；
   *  - 静态画像命中且小类非 M1 → 使用该画像；
   *  - 否则：非 M1 小类且其小类在法域链内链到任务三规则 → 生成 L2「条件初筛」；
   *  - 其余（含 12 个 M1 小类）→ 无画像（L1 资料导航）。
   */
  function coverageFor(data, market, sub, legacy, chain, linked) {
    var prof = null;
    data.coverageProfiles.forEach(function (c) { if (c.market === market && c.legacy === legacy) prof = c; });
    var isM1 = !sub || sub.evidence === 'M1';
    if (prof) {
      if (prof.level === 'L3') return prof;
      if (!isM1) return prof;
    }
    var hasTask3Link = false;
    if (linked) {
      data.rules.some(function (r) {
        if (r.origin === 'task3_verified_rule' && linked[r.id] && chain.indexOf(r.jurisdiction || r.market) >= 0) { hasTask3Link = true; return true; }
        return false;
      });
    }
    if (!isM1 && hasTask3Link) return { market: market, legacy: legacy, level: 'L2', label: '条件初筛', generated: true };
    return null;
  }

  /* ================= 税费引擎 ================= */
  function round2(v) { return Math.round((Number(v) + Number.EPSILON) * 100) / 100; }
  function validNumber(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0; }

  function taxProfileFor(data, input) {
    var legacy = input.product_type || '';
    // UI 保存候选记录 ID；直接调用仍支持 HS 编码。
    var candidate = (data.hsCandidates || []).find(function (c) { return c.id === input.hs_candidate && c.market === input.market; });
    var hs = String(candidate ? candidate.code : (input.hs_candidate || '')).replace(/\./g, '');
    var date = input.import_date || SNAPSHOT_DATE;
    return data.taxProfiles.find(function (row) {
      return row.market === input.market
        && row.product_type === legacy
        && (!hs || hs.indexOf(String(row.hs).replace(/\./g, '')) === 0 || String(row.hs).replace(/\./g, '').indexOf(hs) === 0)
        && (!row.origin_scope || row.origin_scope === 'ANY' || row.origin_scope === input.origin)
        && (!row.effective_from || date >= row.effective_from)
        && (!row.effective_to || date <= row.effective_to);
    }) || null;
  }

  function checkCommon(input, blockers, warnings) {
    if (!input._profileFound) blockers.push('当前产品与市场组合没有已核税费计算画像。');
    if (!input.hs_candidate) blockers.push('尚未选择目的国 HS 候选；已知分项可作阶段测算，完整总额保持为空。');
    if (!input.origin) blockers.push('缺少原产地，不能确认税率情景。');
    if (!validNumber(input.goods_value)) blockers.push('货值/海关价值必须是非负数。');
    if (!input.import_date) blockers.push('缺少进口日期。');
    if (input.import_date && input.import_date > SNAPSHOT_DATE) warnings.push('进口日期晚于最后核验日（' + SNAPSHOT_DATE + '）。按已收录且覆盖该日期的规则测算；未自动确认此后有无修订，请在业务使用前复核。核验日不等于政策失效日。');
    if (input.special_valuation === true || isUnknown(input.special_valuation)) blockers.push('特殊估价事实为「是/不确定」，需先取得专业估价结论，不按常规估价计算。');
  }

  function toNativeCurrency(input, expectedCurrency, blockers) {
    if (input.currency === expectedCurrency) return { factor: 1, currency: expectedCurrency };
    var rate = input.fx_record && Number(input.fx_record.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      blockers.push('币种为 ' + (input.currency || '未填') + '，缺少转换为 ' + expectedCurrency + ' 的法定汇率记录，涉及金额的分项保持为空。');
      return null;
    }
    if (!input.fx_record.source) {
      blockers.push('已填写换算汇率，但缺少汇率来源及日期；不能作为可追溯的法定汇率记录。');
    }
    return { factor: rate, currency: expectedCurrency };
  }

  function makeLine(id, label, classification, rate, base, amount, payer, sourceIds, status) {
    return { id: id, label: label, classification: classification, rate: rate, base: base, amount: amount, payer: payer, sourceIds: sourceIds || [], status: status || 'calculated' };
  }

  function calculateSingapore(data, input) {
    var blockers = [], warnings = [];
    input._profileFound = !!taxProfileFor(data, input);
    checkCommon(input, blockers, warnings);
    var cur = toNativeCurrency(input, 'SGD', blockers);
    var fxBlocked = blockers.some(function (b) { return b.indexOf('汇率') >= 0; });
    var factor = cur ? cur.factor : 1;
    var payer = input.incoterm === 'DDP' ? '卖方（合同承担；进口资格另核）' : '买方/进口申报主体';

    var customsValue = null;
    if (input.incoterm === 'DDP') {
      if (validNumber(input.confirmed_customs_value) && input.valuation_professionally_confirmed === true) {
        customsValue = input.confirmed_customs_value * factor;
      } else {
        blockers.push('DDP 含税总价不能倒算税基；需提供经专业确认的海关价值与费用拆分。');
      }
    } else if (input.price_basis === 'CIF_includes_TI' || input.incoterm === 'CIF') {
      customsValue = validNumber(input.goods_value) ? input.goods_value * factor : null;
    } else {
      if (!validNumber(input.freight) || !validNumber(input.insurance)) {
        blockers.push('FOB/未含运保价格缺少国际运费或保险费，无法确定 CIF 税基。');
      } else if (validNumber(input.goods_value)) {
        customsValue = (input.goods_value + input.freight + input.insurance) * factor;
      }
    }

    var gstBase = customsValue;
    if (input.multiple_sales === true) {
      if (validNumber(input.lsp) && input.last_buyer_is_declarant === true) gstBase = input.lsp * factor;
      else { gstBase = null; blockers.push('进口前多次销售需确认最后买方申报价及申报主体。'); }
    }

    var lowValueRoute = ['low_value', 'postal'].indexOf(input.import_route) >= 0;
    if (lowValueRoute && !(input.gst_status && validNumber(input.consignment_cif) && input.gst_collection_record)) {
      blockers.push('低值/空邮路线需补 GST 注册/征收状态、单件销售值、寄售 CIF 与已征税记录，不能仅按金额门槛判断免税。');
    }

    var profile = taxProfileFor(data, input);
    var dutyRate = profile ? profile.ordinaryRate : null;
    var duty = dutyRate === 0 ? 0 : (customsValue === null || dutyRate === null ? null : round2(customsValue * dutyRate));
    var gst = (gstBase === null || duty === null || lowValueRoute || input.special_valuation !== false || fxBlocked)
      ? null : round2((gstBase + duty) * 0.09);
    var permitFee = 0.9, operatorFee = 2.29;
    var knownSubtotal = (duty === null || gst === null) ? null : round2(duty + gst + permitFee);
    var measuresConfirmed = input.remedy_check === 'confirmed_clear' || input.remedy_check === true;
    if (!measuresConfirmed) blockers.push('本票贸易救济/附加措施尚未确认，完整总额保持为空。');

    var lines = [
      makeLine('customs_value', '海关价值/CIF 基础', '计税基础', null, '商品价及依法计入的国际运保', customsValue === null ? null : round2(customsValue), payer, ['SRC-172', 'SRC-174']),
      makeLine('ordinary_duty', '普通关税', '税', dutyRate, customsValue === null ? null : round2(customsValue), duty, payer, profile ? profile.sourceIds : ['SRC-170', 'SRC-168']),
      makeLine('import_gst', '进口 GST', '税', 0.09, gstBase === null ? null : round2(gstBase), gst, payer, ['SRC-171', 'SRC-174', 'SRC-217'], gst === null ? 'blocked' : 'calculated'),
      makeLine('permit_fee', 'TradeNet 法定许可费', '法定规费', null, '按许可', permitFee, payer, ['SRC-202']),
      makeLine('operator_fee', '典型系统操作费（指示性，非法定）', '操作费用', null, '按许可/消息', operatorFee, payer, ['SRC-202'], 'indicative')
    ];

    return {
      market: 'SG', currency: 'SGD',
      customs_value: customsValue === null ? null : round2(customsValue),
      gst_base: gstBase === null ? null : round2(gstBase),
      ordinary_duty: duty, import_gst: gst,
      ordinary_tax_subtotal: (duty === null || gst === null) ? null : round2(duty + gst),
      statutory_permit_fee: permitFee, indicative_operator_fee: operatorFee,
      known_statutory_subtotal: knownSubtotal,
      complete_total: (blockers.length === 0 && measuresConfirmed) ? knownSubtotal : null,
      lines: lines,
      blockers: blockers.filter(function (x, i, a) { return a.indexOf(x) === i; }),
      warnings: warnings,
      assumptions: ['普通批量应税进口；无豁免、递延或保税安排', 'TradeNet 法定许可费（SGD 0.90）计入法定小计；指示性操作费（SGD 2.29）不计入，随运营商价目更新'],
      snapshotDate: SNAPSHOT_DATE
    };
  }

  function calculateAustralia(data, input) {
    var blockers = [], warnings = [];
    input._profileFound = !!taxProfileFor(data, input);
    checkCommon(input, blockers, warnings);
    var cur = toNativeCurrency(input, 'AUD', blockers);
    var fxBlocked = blockers.some(function (b) { return b.indexOf('汇率') >= 0; });
    var factor = cur ? cur.factor : 1;
    var payer = input.incoterm === 'DDP' ? '卖方（合同承担；进口资格另核）' : '买方/进口申报主体';
    var customsValueRaw = validNumber(input.customs_value_confirmed) ? input.customs_value_confirmed : input.goods_value;
    var customsValue = validNumber(customsValueRaw) ? round2(customsValueRaw * factor) : null;
    if (!validNumber(input.customs_value_confirmed)) warnings.push('海关价值未标记为专业确认，结果仅作阶段测算。');
    var lowValueImport = customsValue !== null && customsValue <= 1000;
    if (lowValueImport) blockers.push('海关价值不超过 AUD 1,000，通常适用低值进口/SAC 路径；本版完整进口申报税费模型不直接套用。');
    if (!validNumber(input.freight) || !validNumber(input.insurance)) blockers.push('GST 基础（VoTI）缺少国际运费或保险费。');

    var eligiblePreference = input.origin_preference === 'reviewed'
      && input.origin_psr_satisfied === true
      && input.origin_documents_valid === true
      && input.transport_conditions_satisfied === true;
    if (input.origin_preference === 'reviewed' && !eligiblePreference) blockers.push('ChAFTA 优惠条件（PSR 满足、原产证明有效、运输条件满足）未全部确认，不能使用优惠税率。');

    var profile = taxProfileFor(data, input);
    var ordinaryRate = profile ? profile.ordinaryRate : null;
    var rate = eligiblePreference ? 0 : ordinaryRate;
    var duty = rate === 0 ? 0 : (customsValue === null || rate === null ? null : round2(customsValue * rate));
    var transportInsurance = (validNumber(input.freight) && validNumber(input.insurance)) ? round2((input.freight + input.insurance) * factor) : null;
    var gstBase = (customsValue === null || duty === null || transportInsurance === null) ? null : round2(customsValue + duty + transportInsurance);
    var gst = (gstBase === null || lowValueImport || input.special_valuation !== false || fxBlocked)
      ? null : round2(gstBase * 0.1);
    var ipc = customsValue === null ? null : (customsValue >= 10000 ? 152 : (customsValue > 1000 ? 50 : 0));
    var biosecurity = customsValue === null ? null : 0;
    if (customsValue > 1000) {
      if (input.import_date >= '2026-07-01') biosecurity = input.transport === 'air' ? 48 : (input.transport === 'sea' ? 71 : null);
      else biosecurity = input.transport === 'air' ? 46 : (input.transport === 'sea' ? 68 : null);
    }
    if (biosecurity === null) blockers.push('运输方式（空运/海运）不足以确定生物安全费。');
    var parts = [duty, gst, ipc, biosecurity];
    var knownSubtotal = parts.some(function (v) { return v === null; }) ? null : round2(duty + gst + ipc + biosecurity);
    var measuresConfirmed = input.remedy_check === 'confirmed_clear' || input.remedy_check === true;
    if (!measuresConfirmed) blockers.push('本票贸易救济/附加措施尚未确认，完整总额保持为空。');
    if (input.sales_state && input.sales_state !== 'VIC') warnings.push('VIC 州级电气安全结论不适用于未指定州或其他州；联邦税费分项仍可单独显示。');

    var lines = [
      makeLine('customs_value', '海关价值 CV', '计税基础', null, '经确认的 CV', customsValue, payer, ['SRC-177', 'SRC-233']),
      makeLine('ordinary_duty', eligiblePreference ? 'ChAFTA 条件优惠关税' : '普通关税', '税', rate, customsValue, duty, payer, eligiblePreference ? ['SRC-233', 'SRC-235', 'SRC-236', 'SRC-237', 'SRC-238'] : (profile ? profile.sourceIds : ['SRC-177'])),
      makeLine('import_gst', '进口 GST', '税', 0.1, gstBase, gst, payer, ['SRC-178', 'SRC-179'], gst === null ? 'blocked' : 'calculated'),
      makeLine('ipc', '进口处理费 IPC', '法定规费', null, customsValue, ipc, payer, ['SRC-180']),
      makeLine('biosecurity', '生物安全费', '法定规费', null, input.transport === 'air' ? '空运' : (input.transport === 'sea' ? '海运' : ''), biosecurity, payer, ['SRC-224'])
    ];

    return {
      market: 'AU', currency: 'AUD',
      customs_value: customsValue, ordinary_duty: duty, import_gst: gst,
      ordinary_tax_subtotal: (duty === null || gst === null) ? null : round2(duty + gst),
      ipc: ipc, biosecurity: biosecurity,
      default_preferential_rate_allowed: eligiblePreference,
      conditional_preferential_scenario: (['conditional', 'reviewed'].indexOf(input.origin_preference) >= 0 && !eligiblePreference) ? '仅列条件，不能已取得优惠' : null,
      preferential_duty_saving: ordinaryRate === 0 ? 0 : (eligiblePreference && customsValue !== null && ordinaryRate !== null ? round2(customsValue * ordinaryRate) : null),
      known_statutory_subtotal: knownSubtotal,
      complete_total: (blockers.length === 0 && measuresConfirmed) ? knownSubtotal : null,
      lines: lines,
      blockers: blockers.filter(function (x, i, a) { return a.indexOf(x) === i; }),
      warnings: warnings,
      assumptions: eligiblePreference ? ['普通完整进口申报', 'ChAFTA 优惠资格、证明与运输条件均由输入声明为已复核，仍需个案确认'] : ['普通完整进口申报，按普通税率情景'],
      snapshotDate: SNAPSHOT_DATE
    };
  }

  function calculateTaxes(data, input) {
    if (input.market === 'SG') return calculateSingapore(data, input);
    if (input.market === 'AU') return calculateAustralia(data, input);
    return {
      market: input.market || null, currency: input.currency || null, lines: [],
      ordinary_duty: null, import_gst: null, known_statutory_subtotal: null, complete_total: null,
      blockers: ['当前市场（' + (input.market || '未选') + '）在静态数据包内仅有资料检索与 HS 候选方向，未建立可复算的税费画像；请查看覆盖缺口说明，不以零税率代替。'],
      warnings: [], assumptions: [], snapshotDate: SNAPSHOT_DATE
    };
  }

  /* ================= 输入指纹 ================= */
  function hashInputs(obj) {
    var s = stableStringify(obj || {});
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    var keys = Object.keys(v).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(v[k]); }).join(',') + '}';
  }

  var api = {
    SNAPSHOT_DATE: SNAPSHOT_DATE, UNKNOWN: UNKNOWN,
    isUnknown: isUnknown,
    evaluateCondition: evaluateCondition,
    jurisdictionChain: jurisdictionChain,
    evaluateScenario: evaluateScenario,
    taxProfileFor: taxProfileFor,
    calculateTaxes: calculateTaxes,
    hashInputs: hashInputs,
    round2: round2
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.VOEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
