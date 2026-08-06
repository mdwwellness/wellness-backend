import express from "express";
import {
    addSpecialization,
    deleteSpecialization,
    getSpecializations,
} from "../controllers/specializationController.ts";
import userAuth from "../middlewares/userAuth.ts";

const specializationRouter = express.Router();

specializationRouter.post("/", userAuth, addSpecialization);
specializationRouter.get("/", userAuth, getSpecializations);
specializationRouter.delete("/:id", userAuth, deleteSpecialization);

export default specializationRouter;
