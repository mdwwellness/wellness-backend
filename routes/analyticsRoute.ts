import express  from "express";
import GetAnalytics from "../controllers/getAnalytics.ts";



const analyticsRoute = express.Router();

analyticsRoute.get("/",GetAnalytics)

export default analyticsRoute