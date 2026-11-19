// 旧方式（2022〜2024）の四麻の取り込みスクリプト。スプレッドシートに紐づく Apps Script から写した。
// Web サービスに移行して廃止する予定。集計のルールを参照するために残している（docs/architecture.md「旧集計」）。
// 公開リポジトリのため、スプレッドシートと Drive フォルダの ID は伏せた（元の値は docs/local/003-sheet-notes.md）。

// 四麻成績を投入する先のSpreadSheetのID、及び牌譜データ取得元のGDriveのID
const SS_ID_4p            = "<SPREADSHEET_ID>";
const DRIVE_ID_4p         = "<DRIVE_FOLDER_ID_4P_INBOX>";
const DRIVE_ARCHIVE_ID_4p = "<DRIVE_FOLDER_ID_4P_ARCHIVE>";

// 挿入先シート名とアーカイブ用GDrive
const resultsSheet4p  = SpreadsheetApp.openById(SS_ID_4p).getSheetByName("四麻Results");
const archiveFolder4p = DriveApp.getFolderById(DRIVE_ARCHIVE_ID_4p);

/** 差分取り込み用 */
function import4pPaifuDelta(){
  import4pPaifu(DRIVE_ID_4p);
}

/** アーカイブした牌譜からの全量再取り込み用（事前にresultsシートをクリアしておくのを推奨） */
function import4pPaifuFromArchive(){
  import4pPaifu(DRIVE_ARCHIVE_ID_4p);
}

/**
 * 牌譜データを取り込んでSpreadSheetに投入する
 * @param {string} driveId - 牌譜データの取得元GDriveID
 */
function import4pPaifu(driveId){
  // JSON一括取得
  let response = DriveApp.getFolderById(driveId).getFiles();

  // JSONとして処理する前に一旦ソート（古い順にinsertしたいので）
  let paifuJsonFiles = [];
  while (response.hasNext()){
    paifuJsonFiles.push(response.next());
  }
  paifuJsonFiles.sort(function(a,b){
    return a.getName().localeCompare(b.getName());
  });

  // ファイルを順次解析してresultsシートに取り込む
  for (let i=0; i<paifuJsonFiles.length; i++){
    let paifu = JSON.parse(paifuJsonFiles[i].getBlob().getDataAsString("utf-8"));

    let result = [];
    for (let j=0; j<4; j++){
      var record = [];
      record[0] = paifu.title[1];      // 対戦日時
      record[1] = 0;                   // 順位
      record[2] = paifu.name[j];       // プレイヤー名
      record[3] = paifu.sc[0+(2*j)];   // スコア
      record[4] = paifu.sc[1+(2*j)];   // pt
      record[5] = "https://game.mahjongsoul.com/?paipu=" + paifu.ref; // URL
      result[j] = record;
    }

    // 順位データを付与するのでソート
    result.sort(function(a, b){
      return b[4] - a[4];
    });

    for (let k=0; k<4; k++){
      result[k][1] = k+1;              // 順位
    }

    // 色つけて結果格納
    resultsSheet4p.insertRows(2,4);
    resultsSheet4p.getRange(2,1,4,6).setValues(result);
    resultsSheet4p.getRange(2,1,4,6).setBackgroundRGB(Math.floor((Math.random()*32)+192),Math.floor((Math.random()*32)+192),Math.floor((Math.random()*32)+192));

    // 取り込み済みファイルをアーカイブ
    paifuJsonFiles[i].moveTo(archiveFolder4p);
  }
}
