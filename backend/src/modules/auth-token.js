'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config');
const { accountVersion, assertAccountEligible } = require('./account-policy');
const ISSUER='test-data-lab-local', AUDIENCE='test-data-lab-desktop', MAX_LIFETIME=7*24*60*60;
function sessionLifetime() {
  const value=config.jwtExpiresIn, match=typeof value==='string' ? /^([1-9]\d{0,6})(s|m|h|d)$/.exec(value) : null;
  const seconds=typeof value==='number' ? value : match ? Number(match[1])*({s:1,m:60,h:3600,d:86400}[match[2]]) : NaN;
  if(!Number.isSafeInteger(seconds) || seconds<1 || seconds>MAX_LIFETIME)throw new Error('JWT_EXPIRES_IN must be a positive duration of at most seven days (for example 1h or 7d).');
  return seconds;
}
function issueToken(user) {
  assertAccountEligible(user);
  return jwt.sign({id:String(user._id),email:user.email,role:user.role,av:accountVersion(user)},config.jwtSecret,{algorithm:'HS256',issuer:ISSUER,audience:AUDIENCE,expiresIn:sessionLifetime()});
}
function verifyToken(token,secret=config.jwtSecret,clock=Math.floor(Date.now()/1000)) {
  if(typeof token!=='string' || token.length>8192)throw new Error('Invalid session');
  const decoded=jwt.verify(token,secret,{algorithms:['HS256'],issuer:ISSUER,audience:AUDIENCE,clockTimestamp:clock,maxAge:MAX_LIFETIME});
  if(!decoded || !/^[a-f0-9]{24}$/i.test(String(decoded.id || '')) || !Number.isSafeInteger(decoded.av) || decoded.av<0 || !Number.isSafeInteger(decoded.iat) || !Number.isSafeInteger(decoded.exp) || decoded.iat>clock+30 || decoded.exp<=decoded.iat || decoded.exp-decoded.iat>MAX_LIFETIME)throw new Error('Invalid session');
  return decoded;
}
function validateStartupSecurity() {
  sessionLifetime();
  if(!config.security.privateJwtConfigured)throw new Error('Configure a private JWT_SECRET of at least 32 bytes before starting Test Data Lab. The historical public development key is refused. No database connection was started.');
  if(config.host !== '127.0.0.1')throw new Error('APP_HOST must be 127.0.0.1 so the local desktop, launcher and companion use the same loopback listener.');
  if(!config.security.allowedOrigins.length || config.security.allowedOrigins.length>32)throw new Error('Configure one to thirty-two exact application origins.');
  for(const origin of config.security.allowedOrigins){let url;try{url=new URL(origin);}catch{throw new Error('APP_ALLOWED_ORIGINS must contain exact HTTP or HTTPS origins.');}if(!['http:','https:'].includes(url.protocol) || url.origin!==origin || url.username || url.password)throw new Error('APP_ALLOWED_ORIGINS must contain exact HTTP or HTTPS origins.');}
}
module.exports={issueToken,verifyToken,sessionLifetime,validateStartupSecurity,ISSUER,AUDIENCE,MAX_LIFETIME};
