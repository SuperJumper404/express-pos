// Installed in the POS backend at src/helpers/platformSupport.js.
function buildSupportHandlers({pool,jwt,key}={}){
 pool=pool||require('../config/dbPool');jwt=jwt||require('jsonwebtoken');key=key||require('./env').envJWTKEY;
 const reply=(res,status,message,data=null)=>{res.setHeader('Cache-Control','no-store, private');return res.status(status).json({code:status,success:status===200,message,pagination:null,data});};
 function support(req){
  const token=(req.headers.authorization||'').split(' ')[1];
  const claims=jwt.verify(token,key,{algorithms:['HS256']});
  if(!claims.platform_support)return null;
  if(!Number.isSafeInteger(claims.platform_support.adminId)||claims.platform_support.adminId<=0||claims.exp-claims.iat>1800||!Number.isFinite(claims.exp)||Number(claims.id)!==Number(req.id)||Number(claims.shopid)!==Number(req.shopid)||Number(req.access)!==0)throw Error('INVALID_SUPPORT_SESSION');
  return {token,claims};
 }
 return {
  async supportProfile(req,res,next){
   try{
    const session=support(req);if(!session)return next();
    const [[u]]=await pool.query('SELECT u.id,u.shopid,u.username,u.email,u.phone,u.image,u.access,u.status FROM users u JOIN shop s ON s.admin_user=u.id AND u.shopid=s.id WHERE u.id=? AND u.shopid=? AND u.access=0 AND u.status=1 LIMIT 1',[Number(req.id),Number(req.shopid)]);
    if(!u)return reply(res,403,'Compte gérant actif introuvable.');
    return reply(res,200,'Profil récupéré.',[{...u,token:session.token,module_permissions:null,is_primary_admin:true,session_subject:'staff',platform_support:true}]);
   }catch{return reply(res,403,'Session backoffice expirée ou invalide.');}
  },
  supportLogout(req,res,next){
   try{if(!support(req))return next();return reply(res,200,'Déconnexion réussie !',true);}
   catch{return reply(res,403,'Session backoffice expirée ou invalide.');}
  },
 };
}
module.exports={buildSupportHandlers};
