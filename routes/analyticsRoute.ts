import express  from "express";
import GetAnalytics from "../controllers/getAnalytics.ts";
import userAuth from "../middlewares/userAuth.ts";


const analyticsRoute = express.Router();

analyticsRoute.get("/",userAuth,GetAnalytics)

export default analyticsRoute