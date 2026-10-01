#!/usr/bin/env bash
# Attach loadlens.net to the CloudFront distribution: wait for the ACM certificate to be issued,
# then set the alternate domain names and the certificate in ONE update. Idempotent: re-running is safe.
set -euo pipefail
export PATH="$PATH:/c/Program Files/Amazon/AWSCLIV2"
REGION=us-east-1
DIST=EJNXG9UBKL2OD
ROOT=/d/webhvac
ARN=$(cat "$ROOT/infra/.tmp/cert-arn.txt")
DOMAINS=("loadlens.net" "www.loadlens.net")

echo "== waiting for the certificate to be issued (DNS validation) =="
for i in $(seq 1 30); do
  ST=$(aws acm describe-certificate --region "$REGION" --certificate-arn "$ARN" --query 'Certificate.Status' --output text 2>/dev/null || echo "?")
  echo "  [$i] status: $ST"
  [ "$ST" = "ISSUED" ] && break
  [ "$ST" = "FAILED" ] && { echo "!! validation failed - check the DNS records"; exit 1; }
  sleep 20
done
[ "$ST" = "ISSUED" ] || { echo "!! certificate still $ST after the wait"; exit 1; }

echo "== reading the current distribution =="
aws cloudfront get-distribution-config --id "$DIST" --output json > "$ROOT/infra/.tmp/cf-before.json"

echo "== building the new configuration (aliases + certificate) =="
python - "D:/webhvac/infra/.tmp/cf-before.json" "D:/webhvac/infra/.tmp/cf-new.json" "$ARN" "${DOMAINS[0]}" "${DOMAINS[1]}" <<'PY'
import json, sys
src, dst, arn, d1, d2 = sys.argv[1:6]
doc = json.load(open(src))
cfg = doc['DistributionConfig']
cfg['Aliases'] = {'Quantity': 2, 'Items': [d1, d2]}
cfg['ViewerCertificate'] = {
    'CloudFrontDefaultCertificate': False,
    'ACMCertificateArn': arn,
    'SSLSupportMethod': 'sni-only',
    'MinimumProtocolVersion': 'TLSv1.2_2021',
    'CertificateSource': 'acm',
}
assert cfg['Comment'] is not None, 'Comment is required'
json.dump(cfg, open(dst, 'w'), indent=1)
print('  aliases:', cfg['Aliases']['Items'])
print('  cert   :', cfg['ViewerCertificate']['ACMCertificateArn'].split('/')[-1], cfg['ViewerCertificate']['MinimumProtocolVersion'])
print('  etag   :', doc['ETag'])
open(dst + '.etag', 'w').write(doc['ETag'])
PY
ETAG=$(cat "$ROOT/infra/.tmp/cf-new.json.etag")

echo "== updating the distribution =="
aws cloudfront update-distribution --id "$DIST" --if-match "$ETAG" \
  --distribution-config "file://D:/webhvac/infra/.tmp/cf-new.json" \
  --query 'Distribution.{Status:Status,Aliases:DistributionConfig.Aliases.Items}' --output json

echo "== waiting for the deployment to finish =="
for i in $(seq 1 40); do
  S=$(aws cloudfront get-distribution --id "$DIST" --query 'Distribution.Status' --output text)
  echo "  [$i] $S"
  [ "$S" = "Deployed" ] && break
  sleep 15
done

echo "== reading it back (the real proof) =="
aws cloudfront get-distribution --id "$DIST" --query 'Distribution.{Status:Status,Aliases:DistributionConfig.Aliases.Items,Cert:DistributionConfig.ViewerCertificate.ACMCertificateArn,Method:DistributionConfig.ViewerCertificate.SSLSupportMethod}' --output json
