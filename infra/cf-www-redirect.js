// infra/cf-www-redirect.js — CloudFront Function (viewer-request), Runtime cloudfront-js-2.0.
// One job: the apex is canonical, so www.loadlens.net/anything 301s to loadlens.net/anything.
function handler(event) {
  var req = event.request;
  var host = req.headers.host && req.headers.host.value;
  if (host && host.indexOf('www.') === 0) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://' + host.slice(4) + req.uri } },
    };
  }
  return req;
}
