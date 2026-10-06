// Valor por defecto vacío: sin captcha hasta configurarlo con
//   npx sst secret set TurnstileSecret <valor> --stage production
export const turnstileSecret = new sst.Secret("TurnstileSecret", "");

// Sal para hashear IPs (nunca se guardan en claro).
export const ipSalt = new random.RandomPassword("IpSalt", { length: 32, special: false });

// Secreto que la CloudFront Function agrega a cada pedido junto con la IP real: la web solo confía en esa IP
// si viene con el secreto (la URL de la Lambda es pública), así nadie puede falsificar la IP del visitante.
export const edgeSecret = new random.RandomPassword("EdgeSecret", { length: 40, special: false });

// Se vinculan (cifrados en el paquete de la Lambda) en vez de ir en variables de entorno visibles en la consola.
export const internalSecrets = new sst.Linkable("Internal", {
  properties: { ipSalt: ipSalt.result, edgeSecret: edgeSecret.result },
});
