// ==UserScript==
// @name         GetPaifuURLs
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  try to take over the world!
// @author       Buntaicho
// @match        https://game.mahjongsoul.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=mahjongsoul.com
// @grant        none
// ==/UserScript==

(function () {
    'use strict';
    const MAX_URL_COUNT = 30; //牌譜URL取得件数、変更可
    const TYPE = 1; // type 1 友人 type 2 マッチング　type 4 大会戦 type 0 段位・友人・大会全て
    const KEY = 76; // デフォルトではLキー(=76)を設定済み、変更する場合は→で調べる https://keycode.info/

    document.addEventListener("keydown", function (e) {
        e = e || window.event;
        if (KEY == e.keyCode || KEY == e.key) {
            getRecords(TYPE);
        }
    });

    function download(text, fileName) {
        console.log("text: " + text);
        let a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
        a.download = fileName;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    async function getRecords(type) {
        let output = {};
        output.records = [{}];
        app.NetAgent.sendReq2Lobby(
            "Lobby",
            "fetchGameRecordList",
            { start: 0, count: MAX_URL_COUNT, type: type },
            function (error, Records) {
                if (Records.record_list.length == 0) {
                    return;
                }
                console.log("データ取得中 / Downloading");
                console.log(Records.record_list.length)
                for (let i = 0; i < Records.record_list.length; i++) {
                    output.records[i] = {};
                    let url = "https://game.mahjongsoul.com/?paipu=" + Records.record_list[i].uuid;
                    let meta = " " + new Date(Records.record_list[i].start_time * 1000).toLocaleString();
                    for (const account of Records.record_list[i].accounts) {
                        meta += " " + account.nickname;
                    }
                    output.records[i].url = url;
                    output.records[i].meta = meta;
                }
                download(JSON.stringify(output, null, "\t").replaceAll("\t", ""), "PaifuURLs_" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + ".txt");
                return;
            });
    }
})();