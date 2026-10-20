# SpotIt, web app (versione 1, senza account)

Web app installabile (PWA) per salvare i posti con cinque giudizi: Tornarci, Andarci, Consigliato, Sconsigliato, Non andarci.

## Cosa fa
- Mappa dei tuoi posti (OpenStreetMap, gratuita) con filtri per giudizio, e vista Lista.
- Salva un posto cercando nome e città, incollando un link di Google Maps, oppure con la posizione attuale.
- Scheda del posto: cambia giudizio, nota, Indicazioni (apre Google Maps), Condividi su WhatsApp.
- Link condiviso: chi lo apre vede il posto consigliato e lo salva con un tocco, anche senza installare l'app.
- Installazione: su Android pulsante "Installa"; su iPhone guida "Aggiungi alla schermata Home".
- Su Android, una volta installata, compare nel menu Condividi (es. da Google Maps).
- Profilo: il tuo nome per le condivisioni, contatori, copia di sicurezza e ripristino, invito su WhatsApp.

## Limiti di questa versione
- I posti sono salvati solo sul telefono (localStorage). Account, amici e sincronizzazione arrivano al passo 2.
- Senza chiave Google la ricerca usa Nominatim di OpenStreetMap: gratis, ma trova meno locali.

## Ricerca con Google (consigliata)
La mappa resta OpenStreetMap (gratis); solo la ricerca dei posti usa Google Places, che trova i locali come Google Maps.
1. Su https://console.cloud.google.com crea un progetto e attiva la fatturazione (serve una carta; c'è una quota gratuita mensile).
2. Attiva "Places API (New)".
3. Crea una chiave API e limitala: restrizione "Siti web" con il dominio dell'app, e restrizione API solo a Places API (New).
4. Imposta un budget con avviso (es. 10 €) in Fatturazione, così non hai sorprese.
5. Scrivi la chiave in `config.js` alla voce `googlePlacesKey`.

"Apri in Maps" apre la scheda del locale nell'app Google Maps del telefono: è un semplice link e non costa nulla.

## Provarla sul computer
Serve un piccolo server locale nella cartella, per esempio `python3 -m http.server 8000`, poi apri http://localhost:8000.

## Metterla online
Qualsiasi hosting di file statici con HTTPS va bene (GitHub Pages, Netlify, Cloudflare Pages). Basta caricare questa cartella.
Quando pubblichi una nuova versione, cambia `CACHE` in `sw.js` (es. `spotit-v2`) così i telefoni scaricano l'aggiornamento.

## File
- `index.html`, `styles.css`, `app.js`: l'app.
- `manifest.webmanifest`, `sw.js`, `icons/`: installazione e funzionamento offline.
- `vendor/leaflet/`: libreria della mappa (Leaflet 1.9.4, licenza BSD-2).
