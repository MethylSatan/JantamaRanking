const { createMajsoulConnection } = require("./majsoul");

const fs = require("fs");
const path = require("path");
const OUTPUT_DIR = path.resolve("output");
const INPUT_DIR = path.resolve("input");
process.env.TZ = "Asia/Tokyo";

main();

async function main() {
  // Authentication
  const conn = await createMajsoulConnection().catch((e) => {
    return Promise.reject(e);
  });
  if (!conn) {
    return;
  }
  try {
    paifuURLs = loadPaifuURLs("PaifuURLs_20231216.txt");
    // console.log(paifuURLs);
    uuids = parsePaifuURLs(paifuURLs);
    console.log(uuids);

    for(uuid of uuids){
        let gameRecord = await conn.rpcCall(".lq.Lobby.fetchGameRecord", {
            game_uuid: uuid,
            client_version_string: conn.clientVersionString,
        });
        let result = parse(gameRecord);
        // console.log(gameRecord)
        // console.log(result)
        filename = getDateStrForFilename(gameRecord) + "_" + result["rule"]["disp"] + ".json"
        console.log(filename);
        writePaifuFile(result, filename);
    }
  } catch (e) {
    console.log(e);
  } finally {
    conn.close();
    console.log("finished")
  }
}

function loadPaifuURLs(file){
  const paifuURLs = JSON.parse(fs.readFileSync(path.join(INPUT_DIR, file), { encoding: "utf8" }));
  return paifuURLs;
}

function parsePaifuURLs(paifuURLs){
  let uuids = [];
  for(record of paifuURLs.records){
    uuids.push(record.url.replace("https://game.mahjongsoul.com/?paipu=", ""));
  }
  return uuids;
}

function getDateStrForFilename(gameRecord){
  // YYYY_MM_DD-hh_mm_ss 
  let date = new Date(gameRecord.head.end_time * 1000);
  let formattedDate = date.getFullYear()
                    + "_" + ("0" + (date.getMonth() + 1)).slice(-2)
                    + "_" + ("0" + date.getDate()).slice(-2)
                    + "-" + ("0" + date.getHours()).slice(-2)
                    + "_" + ("0" + date.getMinutes()).slice(-2)
                    + "_" + ("0" + date.getSeconds()).slice(-2);
  return formattedDate;
}

// This part is forked from "downloadlogs" script by Equim-chan.
// https://gist.githubusercontent.com/Equim-chan/875a232a2c1d31181df8b3a8704c3112/raw/a0533ae7a0ab0158ca9ad9771663e94b82b61572/downloadlogs.js
const NAMEPREF   = 0;     //2 for english, 1 for sane amount of weeb, 0 for japanese

//words that can end up in log, some are mandatory kanji in places
const JPNAME = 0;
const RONAME = 1;
const ENNAME = 2;
const RUNES  = {
    /*rooms*/
    "tonpuu"         : ["東喰",         " East",           " East"                 ],
    "hanchan"        : ["南喰",         " South",          " South"                ],
    "friendly"       : ["友人戦",       "Friendly",        "Friendly"              ],
    "tournament"     : ["大会戦",       "Tounament",       "Tournament"            ],
    "sanma"          : ["三",           "3-Player ",       "3-Player "             ],
    "red"            : ["赤",           " Red",            " Red Fives"            ],
    "nored"          : ["",             " Aka Nashi",      " No Red Fives"         ]
};

function parse(record)
{
    let res        = {};
    let ruledisp   = "";
    let lobby      = ""; //usually 0, is the custom lobby number
    let nplayers   = record.head.result.players.length;
    let nakas      = nplayers - 1; //default

    res["ver"]     = "2.3"; // mlog version number
    res["ref"]     = record.head.uuid; // game id - copy and paste into "other" on the log page to view
    //PF4 is yonma, PF3 is sanma
    res["ratingc"] = "PF" + nplayers;

    //rule display
    if (3 == nplayers && JPNAME == NAMEPREF)
        ruledisp += RUNES.sanma[JPNAME];
    if (record.head.config.meta.mode_id) //ranked or casual
        ruledisp += (JPNAME == NAMEPREF) ?
            cfg.desktop.matchmode.map_[record.head.config.meta.mode_id].room_name_jp
            : cfg.desktop.matchmode.map_[record.head.config.meta.mode_id].room_name_en;
    else if (record.head.config.meta.room_id) //friendly
    {
        lobby    = ": " + record.head.config.meta.room_id; //can set room number as lobby number
        ruledisp += RUNES.friendly[NAMEPREF]; //"Friendly";
        nakas    = record.head.config.mode.detail_rule.dora_count;
        TSUMOLOSSOFF = (3 == nplayers) ? ! record.head.config.mode.detail_rule.have_zimosun : false;
    }
    else if (record.head.config.meta.contest_uid) //tourney
    {
        lobby    = ": " + record.head.config.meta.contest_uid;
        ruledisp += RUNES.tournament[NAMEPREF]; //"Tournament";
        nakas    = record.head.config.mode.detail_rule.dora_count;
        TSUMOLOSSOFF = (3 == nplayers) ? ! record.head.config.mode.detail_rule.have_zimosun : false;
    }
    if (1 == record.head.config.mode.mode)
    {
        ruledisp += RUNES.tonpuu[NAMEPREF]; //" East";
    }
    else if (2 == record.head.config.mode.mode)
    {
        ruledisp += RUNES.hanchan[NAMEPREF]; //" South";
    }
    if (! record.head.config.meta.mode_id && ! record.head.config.mode.detail_rule.dora_count)
    {
        if (JPNAME != NAMEPREF)
            ruledisp += RUNES.nored[NAMEPREF];
        res["rule"] = {"disp" : ruledisp, "aka53" : 0, "aka52" : 0, "aka51": 0};
    }
    else
    {
        if (JPNAME == NAMEPREF)
            ruledisp += RUNES.red[JPNAME];
        res["rule"] = {"disp" : ruledisp, "aka53" : 1, "aka52" : (4 == nakas ? 2 : 1), "aka51": (4 == nplayers ?  1 : 0)};
    }

    res["lobby"] = 0; //tenhou custom lobby - could be tourney id or friendly room for mjs. appending to title instead to avoid 3->C etc. in tenhou.net/5
    // >names
    res["name"] = new Array(4).fill('AI');
    record.head.accounts.forEach(e => res["name"][e.seat] = e.nickname);
    // clean up for sanma AI
    if (3 == nplayers)
    {
        res["name"][3] = "";
    }
    // scores
    let scores   = record.head.result.players
        .map(e => [e.seat, e.part_point_1, e.total_point / 1000]);
    res["sc"]    = new Array(8).fill(0);
    scores.forEach((e, i) => {res["sc"][2 * e[0]] = e[1]; res["sc"][2 * e[0] + 1] = e[2];});
    //optional title - why not give the room and put the timestamp here; 1000 for unix to .js timestamp convention
    res["title"] = [ ruledisp + lobby,
    (new Date(record.head.end_time * 1000)).toLocaleString("ja-JP")
    ];

    return res;
}

function writePaifuFile(record, filename) {
  const target = path.join(OUTPUT_DIR, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  text = JSON.stringify(record, null, "    ")
          .replace(/\n       \s+/g, " ")       //bring up log array items
          .replace(/], \[/g,"],\n        [")   //bump nested lists back down
          .replace(/\n\s+]/g," ]")             //bring up isolated right brackets
          .replace(/\n\s+},\n/g," },\n")       //ditto for non-final curly brackets
         
  fs.writeFileSync(path.join(target), text);
}
