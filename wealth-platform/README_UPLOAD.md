# Virtual Wealth — Rossi Family V4

Pacchetto pronto per aggiornare il sito GitHub Pages.

## File e cartelle da caricare nel repository

- `index.html` nella cartella principale del repository
- `Rossi_Family_Investment_Policy_Statement_v1.1.pdf` nella cartella principale del repository
- `data/portfolio.json` nella cartella `data`
- `scripts/update-market-data.mjs`
- `.github/workflows/update-market-data.yml`
- `package.json`

È necessario mantenere la stessa struttura delle cartelle. Il sito legge `portfolio.json`; l'azione programmata aggiorna quotidianamente quel file.

## Controllo dopo la pubblicazione

1. Attendere il completamento del deploy di GitHub Pages.
2. Aprire `https://matteo-macchi.github.io/wealth-platform/#/`.
3. Aprire Rossi Family e controllare Overview e Investments.
4. Verificare che compaiano 18 posizioni aperte, una posizione Brent chiusa e la liquidità familiare separata.
5. Nella sezione Investments verificare il riepilogo: capitale iniziale EUR 5.000.000, NAV corrente, P/L totale, P/L realizzato e cassa residua.
6. Verificare che WQTM sia presente nel blocco Tactical e che lo storico Brent mostri acquisto 1 aprile, vendita 30 settembre e reinvestimento dei proventi.
7. Verificare il collegamento al portfolio principale e il pulsante `Investment Policy Statement` nel profilo Rossi.

## Aggiornamento interfaccia

- Home e Client Directory sono state unificate in un'unica pagina;
- il profilo Rossi presenta subito situazione patrimoniale, struttura del caso e obiettivi;
- l'IPS v1.1 è scaricabile accanto al profilo di rischio;
- il collegamento in alto riporta al portfolio principale di Matteo Macchi.

## Miglioramenti V2

- esposizione geografica azionaria look-through;
- data e prezzo di ingresso del modello;
- prezzo corrente con decimali riconciliabili;
- costi correnti di ETF, ETC ed ETP;
- coupon, scadenza, YTM e duration disponibili per le obbligazioni;
- tabella scorrevole orizzontalmente con prima colonna fissa;
- distinzione fra capitale disponibile, capitale investito e valore corrente.
- conversione automatica USD/EUR per posizioni quotate in dollari;
- storico delle posizioni chiuse con profitto realizzato, ricavi e rendimento;
- NAV calcolato sul capitale iniziale, senza doppio conteggio dei profitti reinvestiti.

## Aggiornamento automatico

- esecuzione automatica dal lunedì al venerdì alle 18:30 UTC;
- esecuzione manuale disponibile da `Actions` → `Update portfolio market data` → `Run workflow`;
- prezzi e performance 1M/YTD aggiornati per ETF, ETC ed ETP;
- valori di mercato, pesi, P/L, grafici ed esposizioni ricalcolati automaticamente;
- il conto BBVA accumula l'interesse lordo secondo il calendario tassi configurato;
- i sette titoli di Stato diretti restano a prezzo manuale, perché un feed obbligazionario affidabile richiede normalmente una fonte professionale; il cambio del Treasury USA viene comunque aggiornato automaticamente.

Il feed pubblico è indicativo e ritardato: è adatto alla demo, non alla valorizzazione ufficiale di un portafoglio reale.

## Modificare il portafoglio

Quando si modifica `data/portfolio.json`, tutti i grafici e i totali del sito si aggiornano automaticamente. Per una nuova posizione quotata impostare `updateMode: "automatic"`, `priceSymbols`, quantità, prezzo e data di ingresso. Modificare soltanto il file Excel non aggiorna il sito: dopo una modifica strutturale il JSON deve essere rigenerato o aggiornato.
