import {getWxClient, initWechat} from './src/wechat/wechat.ts'

const text = [
    "🚨 Apple 有货提醒",
    "",
    "- 📱 test",
    "- 🏪 门店：test",
    "",
    `⏰ ${new Date().toLocaleString("zh-CN", {hour12: false})}\n`,
    "⚡ 请尽快前往 Apple Store 购买"
].join("\n");


function formatMany(results) {
    const lines = ["🚨 Apple 有货提醒", ""];
    for (const result of results) {
        lines.push(`- 📱 ${result.partNumber}`);
        lines.push(`- 🏪 ${result.storeName}`);
    }
    lines.push("");
    lines.push(`⏰ ${new Date().toLocaleString("zh-CN", {hour12: false})}`);
    return lines.join("\n");
}

const results = [{
    partNumber:"test 1",
    region:"test 1",
    storeName:"test 1",
},{
    partNumber:"test 2",
    region:"test 2",
    storeName:"test 2",
}]

initWechat()
    .then(() => {
        const client = getWxClient();
        if (!client) {
            console.error("wxClient 未初始化，登录可能失败，检查凭证文件");
            process.exit(1);
        }
        return client.sendText({
            toUserId: "o9cq80-rl-B68MNc3cu-NJ5v3SVQ@im.wechat",
            text: formatMany(results),
            contextToken: "AARzJWAFAAABAAAAAAC08zFfHn3YASYlkKqzaiAAAAB+9905Q6UiugPBawU3n3cyzQX+LkN8ofRzsCZYN0mt7saPEN3wrfGXNzdFdsUJ/GSC3vMihP9preY1O8S7hQnfiRDY5Vo4"
        });
    })
    .then(() => {
        console.log("发送完成");
        process.exit(0);
    })
    .catch((e) => {
        console.error("失败:", e);
        process.exit(1);
    });