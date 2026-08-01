const buildTableAccessLoginData = ({ decoded, user, sessionToken }) => {
  if (!decoded || decoded.purpose !== "table_access") {
    throw new Error("Token QR invalide.");
  }
  if (Number(decoded.access) !== 2) {
    throw new Error("Token QR invalide.");
  }
  if (!user) {
    throw new Error("Table introuvable.");
  }
  if (Number(user.status) !== 1) {
    throw new Error("Table inactive.");
  }
  if (Number(user.access) !== 2) {
    throw new Error("Acces table invalide.");
  }
  if (Number(user.shopid) !== Number(decoded.shopid)) {
    throw new Error("Restaurant invalide.");
  }

  return [
    {
      id: user.id,
      shopid: user.shopid,
      username: user.username,
      email: user.email,
      token: sessionToken,
      expired: user.expired,
      phone: user.phone,
      gender: user.gender,
      position: user.position,
      image: user.image,
      status: user.status,
      access: user.access,
      created: user.created,
      updated: user.updated,
    },
  ];
};

module.exports = {
  buildTableAccessLoginData,
};
