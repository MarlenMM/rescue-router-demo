# Rescue Router: interactive demo

Live: https://marlenmm.github.io/rescue-router-demo/

A drone photo after a flood is mapped into clear road, flooded road, flooded/dry building and water by
[Chameleon](https://github.com/GitGyun/chameleon) (Kim et al., ECCV 2024), adapted from only 50 labelled photos.
A router on the predicted map finds how a rescue team reaches each house: by truck, then boat, then the last stretch
on foot (never back into a vehicle). Click a house to see the route, choose where the team enters, and compare with
the labelled map (the same router on the human labels) or swipe between them.

KAIST AIC200 mini-project (Track A + B). This repository holds only the static viewer; the code repository
will be made public after grading.

Data: [FloodNet](https://github.com/BinaLab/FloodNet-Supervised_v1.0) (CDLA-Permissive-1.0);
[RescueNet](https://springernature.figshare.com/collections/RescueNet_A_High_Resolution_UAV_Semantic_Segmentation_Benchmark_Dataset_for_Natural_Disaster_Damage_Assessment/6647354/1)
(figshare release CC0; the GitHub release states CC BY-NC-ND 4.0). Map: [Leaflet](https://leafletjs.com).
