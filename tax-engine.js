(function (global) {
  'use strict';

  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const byId = (rows, id) => number(rows.find(row => row.id === id)?.amount);

  function progressiveTax(base, assumptions) {
    const taxable = Math.max(0, number(base));
    const bands = assumptions.irpefBands;
    const national = Math.min(taxable,bands[0].ceiling)*bands[0].rate
      + Math.max(Math.min(taxable,bands[1].ceiling)-bands[0].ceiling,0)*bands[1].rate
      + Math.max(taxable-bands[1].ceiling,0)*bands[2].rate;
    return national + taxable*assumptions.localSurchargeRate;
  }

  function ukRentalTax(model) {
    const a = model.taxAssumptions;
    const londonRentEur = byId(model.incomeSources,'london-rent');
    const rentGbp = londonRentEur*a.eurToGbp;
    const taxableGbp = Math.max(rentGbp-a.ukPersonalAllowanceGbp,0);
    const taxGbp = Math.min(taxableGbp,a.ukBasicRateBandGbp)*a.ukBasicRate
      + Math.max(taxableGbp-a.ukBasicRateBandGbp,0)*a.ukHigherRate;
    return { rentGbp, taxableGbp, taxGbp, taxEur:taxGbp/a.eurToGbp };
  }

  function recurringIncome(model, overrides={}) {
    const income = Object.fromEntries(model.incomeSources.map(row=>[row.id,number(row.amount)]));
    if (Number.isFinite(Number(overrides.qualifyingWorkIncome))) income['italian-work']=Number(overrides.qualifyingWorkIncome);
    if (Number.isFinite(Number(overrides.additionalForeignIncome))) income['other-foreign']=Number(overrides.additionalForeignIncome);
    return income;
  }

  function scenarioBreakdown(model, scenarioId, overrides={}) {
    const a = model.taxAssumptions;
    const i = recurringIncome(model,overrides);
    const uk = ukRentalTax({...model,incomeSources:model.incomeSources.map(row=>row.id==='london-rent'?{...row,amount:i['london-rent']}:row)});
    const ordinaryFinance = i['tier1-interest']*a.financialIncomeRate
      + i['btp-coupon']*a.qualifyingSovereignRate
      + i['isa-realised']*a.financialIncomeRate
      + i['foreign-sovereign-coupons']*a.qualifyingSovereignRate
      + i['alternatives-income']*a.financialIncomeRate
      + i['other-foreign']*a.financialIncomeRate;
    const domesticFinance = i['tier1-interest']*a.financialIncomeRate+i['btp-coupon']*a.qualifyingSovereignRate;
    const wealthTaxes = model.clientTaxProfile.properties.london.marketValue*a.ivieRate
      + model.clientTaxProfile.legacyAssets.isaValue*a.ivafeRate;
    const ftc = -Math.min(uk.taxEur,i['london-rent']*(a.irpefBands[2].rate+a.localSurchargeRate));
    let base, finance, credit, wealth, substitute;
    if (scenarioId === 'ordinary') {
      base=i['italian-work']+i['verona-rent']+i['london-rent']; finance=ordinaryFinance; credit=ftc; wealth=wealthTaxes; substitute=0;
    } else if (scenarioId === 'impatriati-y1-5') {
      base=i['italian-work']*a.impatriatiTaxableShareY1to5+i['verona-rent']+i['london-rent']; finance=ordinaryFinance; credit=ftc; wealth=wealthTaxes; substitute=0;
    } else if (scenarioId === 'impatriati-y6-10') {
      const share=model.clientTaxProfile.impatriatiExtension.assumedEligible?a.impatriatiTaxableShareY6to10:1;
      base=i['italian-work']*share+i['verona-rent']+i['london-rent']; finance=ordinaryFinance; credit=ftc; wealth=wealthTaxes; substitute=0;
    } else if (scenarioId === 'art24bis-uk-included') {
      base=i['italian-work']+i['verona-rent']; finance=domesticFinance; credit=0; wealth=0; substitute=a.art24bisHistoricalSubstituteTax;
    } else if (scenarioId === 'art24bis-uk-carved-out') {
      base=i['italian-work']+i['verona-rent']+i['london-rent']; finance=domesticFinance+i['isa-realised']*a.financialIncomeRate; credit=ftc; wealth=wealthTaxes; substitute=a.art24bisHistoricalSubstituteTax;
    } else throw new Error(`Unknown tax scenario: ${scenarioId}`);
    const irpef=progressiveTax(base,a);
    const total=irpef+finance+credit+wealth+substitute+uk.taxEur;
    return {scenarioId,taxableProgressiveBase:base,irpefAndSurcharge:irpef,financialTaxes:finance,foreignTaxCredit:credit,ivieIvafe:wealth,substituteTax:substitute,ukRentalTax:uk.taxEur,total,uk};
  }

  function recurringTotalIncome(model, overrides={}) {
    return Object.values(recurringIncome(model,overrides)).reduce((sum,value)=>sum+value,0);
  }

  function realisedEventTax(model, scenarioId) {
    const lines=model.realisedTaxEvents.map(event=>{
      const rate=event.taxRateByScenario?.[scenarioId] ?? event.modelTaxRate ?? 0;
      return {...event,tax:number(event.amount)*number(rate)};
    });
    return {lines,total:lines.reduce((sum,row)=>sum+row.tax,0)};
  }

  function currentYear(model, scenarioId) {
    const recurring=scenarioBreakdown(model,scenarioId);
    const events=realisedEventTax(model,scenarioId);
    return {scenarioId,recurring,events,total:recurring.total+events.total,modelledIncomeAndEvents:recurringTotalIncome(model)+model.realisedTaxEvents.reduce((sum,row)=>sum+number(row.amount),0)};
  }

  function tenYearPaths(model) {
    const ordinary=scenarioBreakdown(model,'ordinary').total;
    const imp1=scenarioBreakdown(model,'impatriati-y1-5').total;
    const imp2=scenarioBreakdown(model,'impatriati-y6-10').total;
    const art=scenarioBreakdown(model,'art24bis-uk-included').total;
    return [
      {id:'ordinary',label:'Ordinary',total:ordinary*10,savingVsOrdinary:0},
      {id:'impatriati',label:'Impatriati',total:imp1*5+imp2*5,savingVsOrdinary:ordinary*10-(imp1*5+imp2*5)},
      {id:'art24bis',label:'Art. 24-bis',total:art*10,savingVsOrdinary:ordinary*10-art*10}
    ];
  }

  function sensitivity(model, workIncome, additionalForeignIncome) {
    const overrides={qualifyingWorkIncome:workIncome,additionalForeignIncome};
    const ids=['ordinary','impatriati-y1-5','art24bis-uk-included'];
    const values=ids.map(id=>({id,total:scenarioBreakdown(model,id,overrides).total}));
    return values.sort((a,b)=>a.total-b.total)[0];
  }

  function calculate(model) {
    const recurring=Object.fromEntries(model.taxRegimes.map(regime=>[regime.id,scenarioBreakdown(model,regime.id)]));
    const current2026=Object.fromEntries(model.taxRegimes.map(regime=>[regime.id,currentYear(model,regime.id)]));
    return {recurring,current2026,tenYear:tenYearPaths(model),recurringIncome:recurringTotalIncome(model)};
  }

  global.VirtualWealthTaxEngine={progressiveTax,ukRentalTax,scenarioBreakdown,realisedEventTax,currentYear,tenYearPaths,sensitivity,calculate};
})(window);
