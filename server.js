const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- Hulpfuncties voor Tijdconversie en Formattering ---

/**
 * Converteert een tijdstring (HH:MM:SS) en een decimaal-string naar seconden.
 * @param {string} timeStr - Tijd in "HH:MM:SS" formaat.
 * @param {string} dcStr - Decimale seconden als string.
 * @returns {number} Totaal aantal seconden, of 0 als de input ongeldig is.
 */
const timeToSeconds = (timeStr, dcStr) => {
  if (!timeStr || timeStr === '00:00:00') return 0;
  const parts = timeStr.split(':');
  const dc = parseInt(dcStr, 10) || 0;
  return (parseInt(parts[0], 10) * 3600) + (parseInt(parts[1], 10) * 60) + parseInt(parts[2], 10) + (dc / 10);
};

/**
 * Formatteert een getal in seconden naar een tijdstring (M:SS.d of HH:MM:SS.d).
 * @param {number} totalSeconds - Het totaal aantal seconden.
 * @returns {string} De geformatteerde tijdstring.
 */
const secondsToTimeFormat = (totalSeconds) => {
    if (isNaN(totalSeconds) || totalSeconds === 0) return "0.0";
    
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = (totalSeconds % 60).toFixed(1);

    let result = '';
    if (hours > 0) {
        result += `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(4, '0')}`;
    } else if (minutes > 0) {
        result += `${minutes}:${String(seconds).padStart(4, '0')}`;
    } else {
        result += seconds;
    }
    return result;
};

/**
 * Berekent het verschil tussen twee splittijden, rekening houdend met middernachtovergang.
 * @param {number} time1_sec - Starttijd in seconden.
 * @param {number} time2_sec - Eindtijd in seconden.
 * @returns {number} Het duurverschil in seconden.
 */
const calculateDuration = (time1_sec, time2_sec) => {
    if (time1_sec === 0 || time2_sec === 0) return 0;
    let duration = time2_sec - time1_sec;
    // Corrigeer voor races die over middernacht gaan
    if (duration < -1000) { // Grote negatieve sprong duidt op middernacht
        duration += 24 * 3600;
    }
    return duration;
};

/**
 * Formatteert het verschil in seconden naar een string met een '+' teken.
 * @param {number} diff - Het verschil in seconden.
 * @returns {string} Geformatteerde verschilstring.
 */
const formatDiff = (diff) => {
    if (diff === 0) return ' '; // Non-breaking space
    const formatted = secondsToTimeFormat(Math.abs(diff));
    return (diff > 0 ? '+' : '-') + formatted;
};

// --- Routes ---

// Root route: detect mobile
app.get('/', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  if (/Mobi|Android|iPhone|iPad/i.test(ua)) {
    return res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API Endpoint voor race data
app.get('/data', async (req, res) => {
  try {
    const response = await fetch('https://raceclocker.com/f6a7da28');
    const html = await response.text();
    const $ = cheerio.load(html);

    let allResultsData = null;

    $('script').each((i, el) => {
      const content = $(el).html();
      const match = content.match(/let AllResults = (\[.*?\]);/s);
      if (match && match[1]) {
        try {
          allResultsData = JSON.parse(match[1]);
        } catch (parseError) {
          console.error('Error parsing AllResults JSON:', parseError.message);
        }
      }
    });

    if (!allResultsData) {
      return res.status(404).json({ error: 'Geen AllResults JSON gevonden in script-tags' });
    }

    // --- DATATRANSFORMATIE LOGICA ---

    // 1. Maak de 'timing' array
    const timing = allResultsData.map(r => ({
        Name: r.Name,
        Bib: r.Bib,
        Club: r.Club,
        Cat: r.Cat,
        WaveName: r.WaveName,
        Age: r.Age,
        Gender: r.Gender,
        Custom: r.Custom,
        Handicap: r.Handicap,
        Start: `${r.TmSplit1}.${r.TmSplit1dc}`,
        "330 m": `${r.TmSplit2}.${r.TmSplit2dc}`,
        "Split 2": `${r.TmSplit3}.${r.TmSplit3dc}`,
        "Split 3": `${r.TmSplit4}.${r.TmSplit4dc}`,
        "Split 4": '00:00:00.0', // Hardcoded as per desired output
        Finish: r.Result === 'In race...' ? `${r.TmSplit5}.${r.TmSplit5dc}` : `${r.TmSplit5}.${r.TmSplit5dc}`,
        Result: r.Result,
        Penalty: r.Penalty,
        PenaltyNote: r.PenaltyNote,
    }));

    // 2. Maak de 'results' array
    const results = [];
    const groupedByWave = allResultsData.reduce((acc, r) => {
        (acc[r.WaveName] = acc[r.WaveName] || []).push(r);
        return acc;
    }, {});

    for (const waveName in groupedByWave) {
        results.push({ Header: waveName });

        const heatData = groupedByWave[waveName];

        // Bereken alle nodige waarden vooraf
        const calculatedData = heatData.map(r => {
            const startSec = timeToSeconds(r.TmSplit1, r.TmSplit1dc);
            const split330Sec = timeToSeconds(r.TmSplit2, r.TmSplit2dc);
            const finishSec = timeToSeconds(r.TmSplit5, r.TmSplit5dc);

            const duration330 = calculateDuration(startSec, split330Sec);
            const durationToFinish = calculateDuration(split330Sec, finishSec);
            const resultSec = parseFloat(r.TmResultSec) || 0;
            
            // Bereken 500m pace. Afstand is ~650m gebaseerd op voorbeelddata.
            // Pace = (Tijd / Afstand) * 500
            const speed = (resultSec > 0) ? (resultSec / 650) * 500 : 0;

            return {
                ...r,
                duration330,
                durationToFinish,
                resultSec,
                speed,
            };
        });

        // Bepaal ranks voor elke sectie
        const rank330 = [...calculatedData].sort((a, b) => (a.duration330 || Infinity) - (b.duration330 || Infinity));
        const rankFinish = [...calculatedData].sort((a, b) => (a.durationToFinish || Infinity) - (b.durationToFinish || Infinity));
        const rankResult = [...calculatedData].sort((a, b) => (a.resultSec || Infinity) - (b.resultSec || Infinity));
        
        const best330 = rank330[0]?.duration330 || 0;
        const bestFinish = rankFinish[0]?.durationToFinish || 0;
        const bestResult = rankResult[0]?.resultSec || 0;

        // Bouw de uiteindelijke objecten
        calculatedData.forEach(r => {
            const rankIn330 = rank330.findIndex(x => x.RaceID === r.RaceID) + 1;
            const rankInFinish = rankFinish.findIndex(x => x.RaceID === r.RaceID) + 1;
            const rankInResult = rankResult.findIndex(x => x.RaceID === r.RaceID) + 1;

            const diff330 = (rankIn330 > 1 && r.duration330 > 0) ? r.duration330 - best330 : 0;
            const diffFinish = (rankInFinish > 1 && r.durationToFinish > 0) ? r.durationToFinish - bestFinish : 0;
            const diffResult = (rankInResult > 1 && r.resultSec > 0) ? r.resultSec - bestResult : 0;

            results.push({
                "Rank": " ",
                "Name": r.Name,
                "Bib nr": r.Bib,
                "baan": r.Custom || ' ',
                "↦ 330 m": secondsToTimeFormat(r.duration330),
                "Diff": formatDiff(diff330),
                "Rank_2": `(${rankIn330 || ' '})`,
                "↦ Finish": secondsToTimeFormat(r.durationToFinish),
                "Diff_2": formatDiff(diffFinish),
                "Rank_3": `(${rankInFinish || ' '})`,
                "Result": r.Result === 'In race...' ? r.Result : secondsToTimeFormat(r.resultSec),
                "Diff_3": formatDiff(diffResult),
                "Rank_4": `(${rankInResult || ' '})`,
                "Speed": secondsToTimeFormat(r.speed),
                "Unit": "/500m"
            });
        });
    }

    // Stuur de getransformeerde data terug
    res.json({ results, timing });

  } catch (err) {
    console.error('Fout bij ophalen/parsen:', err.message);
    res.status(500).json({ error: 'Fout bij ophalen of parsen van gegevens' });
  }
});

// Health check voor uptime monitoring
app.get('/_health', (req, res) => res.send('ok'));

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
