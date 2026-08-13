import time
import random as rd

choices = ["가위", "바위", "보"]

print("가위바위보 게임 시작!")
time.sleep(0.5)

usr_choice = input("당신의 선택: ")
cpt_choice = rd.choice(choices)
result = ""



if usr_choice == "가위" and cpt_choice == "보":
  result = "승리"
elif usr_choice == "가위" and cpt_choice == "바위":
  result = "패배"
elif usr_choice == "바위" and cpt_choice == "가위":
  result = "승리"
elif usr_choice == "바위" and cpt_choice == "보":
  result = "패배"
elif usr_choice == "보" and cpt_choice == "바위":
  result = "승리"
elif usr_choice == "보" and cpt_choice == "가위":
  result = "패배"
else:
  result = "무승부"
  
time.sleep(0.5)
print("가위")
time.sleep(1)
print("바위")
time.sleep(1)
print("보!")
time.sleep(0.25)
print(f"당신: {usr_choice} | 컴퓨터: {cpt_choice}")
time.sleep(0.25)
print("결과: " + result)