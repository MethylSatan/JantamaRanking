// Extract token from hexed WS message
hexstr = process.argv[2];
token1 = hexstr.substr(62, 64);
token2 = hexstr.substr(130, 16);
token = Buffer.from(token1, "hex").toString() + '-' + Buffer.from(token2, "hex").toString();
console.log(token);
